/**
 * Admin Routes
 *
 * Admin-only endpoints for platform management.
 */

import { Hono } from 'hono';
import * as crypto from 'crypto';
import { success, error, ErrorCodes } from '../types';
import { getActivityLog } from '../../managers/activity';
import { suspendUser, updateUser, listUsers, AuthContext } from '../middleware/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppRuntime } from '../../managers/runtime';
import { logActivityFor } from '../../managers/activity';
import { getDiskFreeMb } from '../../utils/disk';
import { getSettingsManager } from '../../managers/settings/settings-manager';
import type { MailSettings } from '../../managers/settings/settings-manager';
import { normalizePublicUrl } from '../../utils/url-validator';
import { getPublicUrl, setPublicUrl, isAccessGateEnabled } from '../runtime-config';
import { getMailCredentialStore } from '../../managers/mailer/mail-credential';
import { sendTemplatedMail } from '../../managers/mailer/mailer';

const admin = new Hono();

type SettingsSource = 'stored' | 'env' | 'unset';

/** Shared payload shape for GET /settings and the "cleared" branch of PUT /settings/public-url. */
function buildSettingsPayload(): { publicUrl: string | null; source: SettingsSource; storedPublicUrl: string | null } {
  const storedPublicUrl = getSettingsManager().getStoredPublicUrl() ?? null;
  const source: SettingsSource = storedPublicUrl ? 'stored' : process.env.DROP_PUBLIC_URL ? 'env' : 'unset';
  return {
    publicUrl: getPublicUrl() ?? null,
    source,
    storedPublicUrl,
  };
}

interface GithubWebhookPayload {
  configured: boolean;
  source: SettingsSource;
  payloadUrl: string | null;
}

/**
 * Status block for the GitHub webhook HMAC secret (stored value wins over
 * DROP_GITHUB_WEBHOOK_SECRET — see src/api/routes/git-deploy.ts). Used by
 * GET /admin/settings and by the generate/PUT responses below; never
 * includes the secret value itself.
 */
function buildGithubWebhookPayload(): GithubWebhookPayload {
  const stored = getSettingsManager().getGithubWebhookSecret();
  const source: SettingsSource = stored ? 'stored' : process.env.DROP_GITHUB_WEBHOOK_SECRET ? 'env' : 'unset';
  const publicUrl = getPublicUrl();
  return {
    configured: source !== 'unset',
    source,
    payloadUrl: publicUrl ? `${publicUrl}/api/v1/git/webhook` : null,
  };
}

/**
 * Status block for the non-admin MCP-connector toggle (PRD: multi-user MCP
 * connectors). Kept separate from buildSettingsPayload() — that helper is
 * also used by the "cleared" branch of PUT /settings/public-url, and adding
 * this field there would silently change that endpoint's response shape too.
 */
function buildUserConnectorsPayload(): { enabled: boolean } {
  return { enabled: getSettingsManager().getUserConnectorsEnabled() };
}

/**
 * Status block for the DROP-153 app-sharing toggle. Kept separate from
 * buildUserConnectorsPayload() for the same reason that one is kept separate
 * from buildSettingsPayload() — a distinct product surface with its own
 * default (DISABLED — see the `appSharingEnabled` field comment in
 * SettingsManager), not a variant to fold into an existing payload shape.
 */
function buildAppSharingPayload(): { enabled: boolean } {
  return { enabled: getSettingsManager().getAppSharingEnabled() };
}

interface MailPayload {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  shareNotificationsEnabled: boolean;
  /**
   * Whether the mailer currently has a password to authenticate with (env
   * `DROP_SMTP_PASSWORD`, or the stored, encrypted credential). Computed via
   * `resolveMailPassword()` and reduced to a boolean here — the plaintext
   * itself must never reach a route response (see that function's own
   * warning in `mail-credential.ts`). This is honest about the DROP-154 §3
   * host/credential coupling: changing `smtpHost` clears the stored
   * credential (a different host means the saved password is for a relay
   * that no longer matches), so this flips to `false` immediately after a
   * `PUT /settings/mail` that changes `host`, even though nobody explicitly
   * cleared the credential.
   */
  credentialConfigured: boolean;
}

/**
 * Status block for the DROP-154 mail settings (SMTP relay config + the
 * `shareNotificationsEnabled` toggle). Kept separate from the other
 * build*Payload() helpers for the same reason those are kept separate from
 * each other — a distinct product surface with its own shape, not a variant
 * to fold into an existing payload. Never includes the password, in any
 * form — see `credentialConfigured` above.
 */
async function buildMailPayload(): Promise<MailPayload> {
  const mail = getSettingsManager().getMailSettings();
  const credentialConfigured = (await getMailCredentialStore().resolveMailPassword()) !== null;
  return {
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    user: mail.user,
    from: mail.from,
    shareNotificationsEnabled: getSettingsManager().getShareNotificationsEnabled(),
    credentialConfigured,
  };
}

const GITHUB_WEBHOOK_SECRET_MIN_LENGTH = 8;
const GITHUB_WEBHOOK_SECRET_MAX_LENGTH = 256;
// eslint-disable-next-line no-control-regex -- deliberately matching ASCII control chars (incl. DEL) to reject them.
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/**
 * The request body shape every settings PUT below requires: a JSON object,
 * not null and not an array. Without it a body of `null` or `[]` dereferences
 * a property access into a TypeError that surfaces as a 500 — a poor answer
 * from a validator whose whole contract is "reject rather than coerce".
 */
function isJsonObjectBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

/**
 * Strict boolean field extraction for the two-state policy toggles below
 * (user-connectors, app-sharing): `undefined` means "reject", never "treat
 * as false" — these are not clear-to-fall-back fields like publicUrl or the
 * webhook secret.
 */
function requireBooleanField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

// GET /admin/activity - Activity log (paginated)
admin.get('/activity', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const log = getActivityLog();
  const { entries, total } = log.getEntries(limit, offset);

  return c.json(success(entries, { total, limit, offset }));
});

// POST /admin/users/:id/suspend - Suspend a user account
// Disables login and stops all their running apps.
admin.post('/users/:id/suspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const userId = c.req.param('id');

  try {
    const suspended = await suspendUser(userId);
    if (!suspended) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Suspend failed';
    return c.json(error(ErrorCodes.BAD_REQUEST, msg), 400);
  }

  // Stop all running apps owned by this user
  const stateManager = getStateManager();
  const runtime = getAppRuntime();
  const userApps = stateManager.getAllApps().filter((a) => a.userId === userId);
  const stopErrors: string[] = [];
  for (const app of userApps) {
    try {
      await runtime.stop(app.name);
      await stateManager.setAppStatus(app.name, 'stopped');
    } catch (err) {
      stopErrors.push(`${app.name}: ${err instanceof Error ? err.message : 'stop failed'}`);
    }
  }

  await logActivityFor(authCtx, {
    action: 'suspend',
    detail: `Suspended user ${userId}; stopped ${userApps.length} app(s)`,
  });

  return c.json(
    success({
      suspended: true,
      appsStoppedCount: userApps.length - stopErrors.length,
      stopErrors: stopErrors.length > 0 ? stopErrors : undefined,
    })
  );
});

// POST /admin/users/:id/unsuspend - Re-enable a suspended user account
admin.post('/users/:id/unsuspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const userId = c.req.param('id');

  const updated = await updateUser(userId, { enabled: true });
  if (!updated) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }

  await logActivityFor(authCtx, {
    action: 'unsuspend',
    detail: `Unsuspended user ${userId}`,
  });

  return c.json(success({ suspended: false }));
});

// GET /admin/quota - Platform-wide quota / resource summary (df-style)
admin.get('/quota', async (c) => {
  const stateManager = getStateManager();
  const allApps = stateManager.getAllApps();
  const users = listUsers();

  const appsDir = process.env.DROP_APPS_DIR || '';
  const freeDiskMb = appsDir ? await getDiskFreeMb(appsDir).catch(() => null) : null;

  const byUser = users.map((u) => {
    const uApps = allApps.filter((a) => a.userId === u.id);
    return {
      userId: u.id,
      username: u.username,
      enabled: (u as any).enabled !== false,
      appCount: uApps.length,
      runningCount: uApps.filter((a) => a.status === 'running').length,
    };
  });

  const buildingApps = allApps.filter((a) => a.status === 'building');

  return c.json(
    success({
      apps: {
        total: allApps.length,
        running: allApps.filter((a) => a.status === 'running').length,
        building: buildingApps.length,
        buildingApps: buildingApps.map((a) => a.name),
        errored: allApps.filter((a) => a.status === 'errored').length,
      },
      disk: freeDiskMb !== null ? { freeMb: Math.round(freeDiskMb) } : null,
      byUser,
    })
  );
});

// POST /admin/apps/:name/suspend - Stop an app and mark it suspended
admin.post('/apps/:name/suspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const appName = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(appName);

  if (!app) {
    return c.json(error(ErrorCodes.NOT_FOUND, `Application '${appName}' not found`), 404);
  }

  const runtime = getAppRuntime();
  try {
    await runtime.stop(appName);
  } catch {
    // Best-effort — app may already be stopped
  }
  await stateManager.setAppStatus(appName, 'stopped', { error: 'Suspended by admin' });

  await logActivityFor(authCtx, {
    action: 'suspend',
    appName,
    detail: 'App suspended by admin',
  });

  return c.json(success({ appName, suspended: true }));
});

// GET /admin/settings - Platform settings: the public base URL / OAuth
// issuer override (PRD-041) plus the GitHub webhook secret status and the
// non-admin MCP-connector toggle.
admin.get('/settings', async (c) => {
  return c.json(
    success({
      ...buildSettingsPayload(),
      githubWebhook: buildGithubWebhookPayload(),
      userConnectors: buildUserConnectorsPayload(),
      appSharing: buildAppSharingPayload(),
      mail: await buildMailPayload(),
    })
  );
});

// PUT /admin/settings/public-url - Set or clear the admin override for
// DROP_PUBLIC_URL (the OAuth issuer/resource base). Security-adjacent:
// validated HTTPS-only (except localhost) via normalizePublicUrl, and a
// bad/empty value fails CLOSED — it never derives an issuer from the Host
// header. Updates both the persisted store and the live runtime config so
// the change takes effect immediately, without a restart.
admin.put('/settings/public-url', async (c) => {
  const body = (await c.req.json()) as { publicUrl?: unknown };
  const input = body.publicUrl;

  if (input === null || input === undefined || input === '') {
    await getSettingsManager().setPublicUrl(undefined);
    setPublicUrl(undefined);
    return c.json(success(buildSettingsPayload()));
  }

  if (typeof input !== 'string') {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'publicUrl must be a string or null'), 400);
  }

  const result = normalizePublicUrl(input);
  if (!result.ok) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, result.reason), 400);
  }

  await getSettingsManager().setPublicUrl(result.value);
  setPublicUrl(result.value);

  return c.json(success({ publicUrl: result.value, source: 'stored' as const, storedPublicUrl: result.value }));
});

// POST /admin/settings/github-webhook-secret/generate - Generate a new random
// GitHub webhook HMAC secret, store it, and reveal it exactly once in this
// response (it never appears in any other response, including GET /settings).
admin.post('/settings/github-webhook-secret/generate', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;

  const secret = crypto.randomBytes(32).toString('hex');
  await getSettingsManager().setGithubWebhookSecret(secret);

  await logActivityFor(authCtx, {
    action: 'github-webhook-secret-generate',
  });

  return c.json(success({ secret, ...buildGithubWebhookPayload() }));
});

// PUT /admin/settings/github-webhook-secret - Set or clear the stored GitHub
// webhook HMAC secret. `null`/empty/whitespace-only clears it (mirrors
// PUT /settings/public-url — no separate DELETE). The secret value is never
// echoed back, in either the success or the validation-error response.
admin.put('/settings/github-webhook-secret', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const input = body.secret;

  if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
    await getSettingsManager().setGithubWebhookSecret(undefined);
    await logActivityFor(authCtx, {
      action: 'github-webhook-secret-clear',
    });
    return c.json(success(buildGithubWebhookPayload()));
  }

  if (typeof input !== 'string') {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'secret must be a string or null'), 400);
  }

  const trimmed = input.trim();
  if (trimmed.length < GITHUB_WEBHOOK_SECRET_MIN_LENGTH) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        `Secret must be at least ${GITHUB_WEBHOOK_SECRET_MIN_LENGTH} characters — generate one instead`
      ),
      400
    );
  }
  if (trimmed.length > GITHUB_WEBHOOK_SECRET_MAX_LENGTH) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, `Secret must be at most ${GITHUB_WEBHOOK_SECRET_MAX_LENGTH} characters`),
      400
    );
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Secret must contain only printable characters'), 400);
  }

  await getSettingsManager().setGithubWebhookSecret(trimmed);
  await logActivityFor(authCtx, {
    action: 'github-webhook-secret-set',
  });

  return c.json(success(buildGithubWebhookPayload()));
});

// PUT /admin/settings/user-connectors - Gate whether non-admin (`user`-role)
// accounts may set up a claude.ai MCP connector. Strict boolean: this is a
// two-state policy toggle, not a "clear to fall back" field like publicUrl
// or the webhook secret, so a non-boolean is rejected rather than coerced or
// treated as a clear.
admin.put('/settings/user-connectors', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const input = requireBooleanField(body, 'enabled');
  if (input === undefined) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'enabled must be a boolean'), 400);
  }

  await getSettingsManager().setUserConnectorsEnabled(input);

  await logActivityFor(authCtx, {
    action: 'user-connectors-set',
    detail: `Non-admin MCP connectors ${input ? 'enabled' : 'disabled'}`,
  });

  return c.json(success(buildUserConnectorsPayload()));
});

// PUT /admin/settings/app-sharing - Gate whether an app's OWNER may share it
// (DROP-153's `/apps/:name/share` routes). Same strict-boolean shape as PUT
// /settings/user-connectors above: a two-state policy toggle, not a
// "clear to fall back" field, so a non-boolean is rejected rather than
// coerced or treated as a clear.
admin.put('/settings/app-sharing', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const input = requireBooleanField(body, 'enabled');
  if (input === undefined) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'enabled must be a boolean'), 400);
  }

  await getSettingsManager().setAppSharingEnabled(input);

  await logActivityFor(authCtx, {
    action: 'app-sharing-set',
    detail: `App sharing ${input ? 'enabled' : 'disabled'}`,
  });

  // Reported HERE, not as a boot warning: the gate switch is a boot-time env
  // var while this setting is runtime-settable, so the contradiction is
  // created by this request and a boot check could never see it.
  const warning =
    input && !isAccessGateEnabled()
      ? 'App sharing is enabled, but the access gate is switched off ' +
        '(DROP_FEATURE_ACCESS_GATE=false), so sharing an app will be refused until ' +
        'the gate is turned back on and the platform restarted.'
      : undefined;

  return c.json(success({ ...buildAppSharingPayload(), ...(warning ? { warning } : {}) }));
});

const MAIL_PORT_MIN = 1;
const MAIL_PORT_MAX = 65535;

/**
 * Validates one of `MailSettings`' free-text fields (`host`/`user`/`from`):
 * `null` or an empty/whitespace-only string clears the field (mirrors
 * `PUT /settings/github-webhook-secret`'s null-clears shape); a control
 * character (including CR/LF/NUL — `CONTROL_CHAR_PATTERN` covers `\x00-\x1f`)
 * is refused rather than persisted, so a header-injection payload never even
 * reaches disk — `mailer.ts` re-checks independently at send time, but this
 * is the route's own boundary, not a substitute for that one.
 */
function normalizeMailStringField(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === null) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = value.trim();
  if (CONTROL_CHAR_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed === '' ? undefined : trimmed };
}

// PUT /admin/settings/mail - Set (or, per field, clear) the non-secret SMTP
// relay settings plus the shareNotificationsEnabled toggle. NEVER the
// password — see PUT /settings/mail/credential below.
//
// `setMailSettings` distinguishes KEY PRESENCE from value truthiness
// (`{ host: undefined }` deliberately wipes the host and, via the host-change
// check inside it, clears the stored credential) — so `partial` below is
// built field-by-field from what the body actually CONTAINS, never by
// spreading the body in. A field omitted from the body is left untouched.
//
// Every field is validated BEFORE either settings-manager write below, so a
// bad field 400s without any partial mutation — `setMailSettings` is called
// at most once, and only after every field in the body has passed.
admin.put('/settings/mail', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const partial: MailSettings = {};

  if ('host' in body) {
    const result = normalizeMailStringField(body.host);
    if (!result.ok) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'host must be a string or null'), 400);
    }
    partial.host = result.value;
  }

  if ('port' in body) {
    const value = body.port;
    if (value === null) {
      partial.port = undefined;
    } else if (typeof value !== 'number' || !Number.isInteger(value) || value < MAIL_PORT_MIN || value > MAIL_PORT_MAX) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, `port must be an integer between ${MAIL_PORT_MIN} and ${MAIL_PORT_MAX}, or null`),
        400
      );
    } else {
      partial.port = value;
    }
  }

  if ('secure' in body) {
    const value = body.secure;
    if (typeof value !== 'boolean') {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'secure must be a boolean'), 400);
    }
    partial.secure = value;
  }

  if ('user' in body) {
    const result = normalizeMailStringField(body.user);
    if (!result.ok) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'user must be a string or null'), 400);
    }
    partial.user = result.value;
  }

  if ('from' in body) {
    const result = normalizeMailStringField(body.from);
    if (!result.ok) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'from must be a string or null'), 400);
    }
    partial.from = result.value;
  }

  let shareNotificationsEnabled: boolean | undefined;
  if ('shareNotificationsEnabled' in body) {
    shareNotificationsEnabled = requireBooleanField(body, 'shareNotificationsEnabled');
    if (shareNotificationsEnabled === undefined) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'shareNotificationsEnabled must be a boolean'), 400);
    }
  }

  // setMailSettings first: it's the write that can clear the stored
  // credential (on a host change), so it goes first — if the second write
  // below fails, the relay config + credential are still internally
  // consistent with each other, only the notification toggle is stale.
  await getSettingsManager().setMailSettings(partial);
  if (shareNotificationsEnabled !== undefined) {
    await getSettingsManager().setShareNotificationsEnabled(shareNotificationsEnabled);
  }

  await logActivityFor(authCtx, {
    action: 'mail-settings-set',
    detail: 'Mail settings updated',
  });

  return c.json(success(await buildMailPayload()));
});

// PUT /admin/settings/mail/credential - Write-only: sets the SMTP relay
// password via the mailer's own encrypted credential store
// (mail-credential.ts). Never read back — GET /settings only ever reports
// `mail.credentialConfigured` (a boolean), never the value.
admin.put('/settings/mail/credential', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const password = body.password;
  if (typeof password !== 'string' || password === '') {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'password must be a non-empty string'), 400);
  }

  try {
    await getMailCredentialStore().setMailPassword(password);
  } catch {
    // Only thrown when encryption.key is absent/wrong-length — an operator
    // environment problem, not a bad request. Mirrors the `no_key` posture
    // POST /auth/mfa/enable already uses for the same underlying key.
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, 'SMTP encryption key not available. Contact the server operator.'),
      500
    );
  }

  await logActivityFor(authCtx, {
    action: 'mail-settings-set',
    detail: 'SMTP credential set',
  });

  return c.json(success(await buildMailPayload()));
});

// POST /admin/mail/test - Send the fixed `test` template to an admin-supplied
// address to confirm the relay settings actually work. Reports only the
// two-value `MailSendResult` status ('sent' | 'unavailable') — the relay's
// own reply (e.g. 550/552) never reaches this response; see mailer.ts's file
// header for why that would be a directory-enumeration oracle.
admin.post('/mail/test', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json()) as unknown;

  if (!isJsonObjectBody(body)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Request body must be a JSON object'), 400);
  }

  const to = body.to;
  if (typeof to !== 'string' || to.trim() === '') {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'to must be a non-empty string'), 400);
  }

  const result = await sendTemplatedMail('test', to.trim(), { platformUrl: getPublicUrl() ?? '' });

  await logActivityFor(authCtx, {
    action: 'mail-test-sent',
    detail: `to=${to.trim()} status=${result.status}`,
  });

  return c.json(success({ status: result.status }));
});

export default admin;
