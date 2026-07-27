/**
 * Agent-token scope grammar (Step 6b).
 *
 * An agent token is a `role: 'none'` API key — no role standing at all — whose
 * entire authority is a list of scopes naming specific apps:
 *
 *   app:<name>:deploy     redeploy that one app
 *   app:<name>:read       read that one app's status and logs
 *   apps:create           create NEW apps (not tied to a name, since the name
 *                         does not exist yet)
 *
 * SEC-10. Both halves of this are places a plausible implementation leaks
 * authority, and each omission is a real hole rather than a nicety:
 *
 * MINT TIME — `parseAgentScope` requires exactly three colon-separated parts,
 * a part 2 that passes `isValidAppName`, and a part 3 in a closed verb set.
 * Then `assertMintable` additionally requires the REQUESTER to already have
 * access to every app named. Without that last check any authenticated user
 * mints `app:<someone-elses-app>:deploy` for themselves and deploys over it.
 *
 * CHECK TIME — comparison is `===` on the full normalized scope string, never
 * `startsWith`. A `startsWith('app:' + name)` implementation hands the holder
 * of `app:foo:deploy` authority over `foobar`, `foo-staging`, and every other
 * app whose name begins with `foo`.
 *
 * App names normalize to lower case at BOTH ends, so a scope minted for `Foo`
 * matches a request for `foo` and — more importantly — cannot be used to smuggle
 * a second, differently-cased grant past a de-duplication check.
 *
 * The `:` delimiter is safe because `APP_NAME_RE` excludes it, so a name can
 * never split into extra parts.
 */

import { isValidAppName } from './middleware/validate';

/** Verbs an app-scoped grant may carry. Closed set. */
export const AGENT_VERBS = ['deploy', 'read'] as const;
export type AgentVerb = (typeof AGENT_VERBS)[number];

/** The one scope that names no app, because the app does not exist yet. */
export const SCOPE_APPS_CREATE = 'apps:create';

export interface ParsedAgentScope {
  kind: 'app';
  appName: string;
  verb: AgentVerb;
}

/**
 * Parse and validate one scope string. Returns null for anything that is not a
 * well-formed app scope — including `apps:create`, which is handled separately
 * because it names no app.
 */
export function parseAgentScope(scope: string): ParsedAgentScope | null {
  if (typeof scope !== 'string') return null;

  const parts = scope.split(':');
  // EXACTLY three. Two would be ambiguous with `apps:create`; four means
  // something contained a delimiter it should not have.
  if (parts.length !== 3) return null;
  if (parts[0] !== 'app') return null;

  const appName = parts[1].toLowerCase();
  if (!isValidAppName(appName)) return null;

  const verb = parts[2];
  if (!(AGENT_VERBS as readonly string[]).includes(verb)) return null;

  return { kind: 'app', appName, verb: verb as AgentVerb };
}

/** Canonical form of a scope, so mint-time and check-time strings compare equal. */
export function normalizeAgentScope(scope: string): string | null {
  if (scope === SCOPE_APPS_CREATE) return SCOPE_APPS_CREATE;
  const parsed = parseAgentScope(scope);
  return parsed ? `app:${parsed.appName}:${parsed.verb}` : null;
}

/** Build the canonical scope string for an app + verb. */
export function agentScopeFor(appName: string, verb: AgentVerb): string {
  return `app:${appName.toLowerCase()}:${verb}`;
}

/**
 * Whether a scope list grants `verb` on `appName`.
 *
 * `===` on the normalized string. NOT `startsWith`, and not a prefix test of
 * any kind — see the SEC-10 note above.
 */
export function scopesAllow(
  scopes: string[] | undefined,
  appName: string,
  verb: AgentVerb
): boolean {
  if (!scopes || scopes.length === 0) return false;
  const wanted = agentScopeFor(appName, verb);
  for (const raw of scopes) {
    if (normalizeAgentScope(raw) === wanted) return true;
  }
  return false;
}

/** Whether a scope list carries the create-new-apps grant. */
export function scopesAllowCreate(scopes: string[] | undefined): boolean {
  return (scopes ?? []).some((s) => normalizeAgentScope(s) === SCOPE_APPS_CREATE);
}

export interface ScopeMintCheck {
  ok: boolean;
  /** Populated when ok is false. Safe to return to the caller — names only. */
  reason?: string;
  /** The canonical scopes to persist, when ok. */
  normalized?: string[];
}

/**
 * Validate a requested scope list at MINT time.
 *
 * `canAccessApp` is supplied by the caller rather than imported, so this module
 * stays pure and testable — and so the ownership rule cannot be quietly
 * skipped by a caller that forgets to pass it.
 */
export function assertMintable(
  requested: unknown,
  canAccessApp: (appName: string) => boolean
): ScopeMintCheck {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, reason: 'At least one scope is required' };
  }
  if (requested.length > 64) {
    return { ok: false, reason: 'Too many scopes' };
  }

  const normalized: string[] = [];
  for (const raw of requested) {
    if (typeof raw !== 'string') {
      return { ok: false, reason: 'Scopes must be strings' };
    }

    const canonical = normalizeAgentScope(raw);
    if (!canonical) {
      return {
        ok: false,
        reason: `Not a valid scope. Use app:<name>:deploy, app:<name>:read, or ${SCOPE_APPS_CREATE}.`,
      };
    }

    if (canonical !== SCOPE_APPS_CREATE) {
      const parsed = parseAgentScope(canonical);
      // THE check that stops privilege escalation: a requester may only grant
      // authority they already hold. Without it, any authenticated user mints
      // a token for someone else's app.
      if (!parsed || !canAccessApp(parsed.appName)) {
        return { ok: false, reason: `No such app, or not yours: ${parsed?.appName ?? 'unknown'}` };
      }
    }

    if (!normalized.includes(canonical)) normalized.push(canonical);
  }

  return { ok: true, normalized };
}
