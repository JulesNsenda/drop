import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import { apiJsonWithStatus, jsonBody } from '../api/client';
import Card from './ui/Card';
import Button from './ui/Button';
import Input from './ui/Input';
import InviteLinkPanel from './InviteLinkPanel';
import { AccountGrantRow, GuestGrantRow } from './ShareGrantRows';
import {
  gateNotReappliedText,
  inviteSecretUrl,
  shareRefusal,
  type OwnGrant,
  type ShareView,
} from '../lib/app-share';

/**
 * Owner-facing app sharing (DROP-153).
 *
 * `AccessTab` is the ADMIN governance view — the full allow-list, review
 * dates, recent openers. This is the narrower, WRITE-capable view the owner
 * of an app gets instead: `GET /apps/:name/share` deliberately returns only
 * the caller's own grants (id + username) plus a COUNT of everyone else's
 * (`othersGrantedCount`), never their identities — disclosing an admin's
 * governance list to the party it governs is exactly what the provenance
 * work (`grantedBy`) exists to prevent. Never render more than the API gives.
 *
 * Two more asymmetries with `AccessTab`, both load-bearing:
 *
 *   - Creating a gate here is an ACKNOWLEDGED act, not a side effect of the
 *     first share. When `policyPresent` is false, sharing turns a live public
 *     app sign-in-only for everyone else, and only an admin can undo it — so
 *     the first grant on an ungated app is confirmed explicitly before
 *     `gateApp: true` is ever sent.
 *   - `blockers` (why a gate cannot be enforced right now) come back as
 *     CODES, never the admin route's `reasons` prose — that prose describes
 *     the platform's own internals (ICC state, API port health) and this
 *     route is reachable by a plain `user`-role owner. `BLOCKER_COPY` below
 *     is this view's own, owner-safe wording; an unrecognised code still
 *     renders something generic rather than the raw string.
 *
 * `gateApplied === false` gets its own warning for the same reason it does in
 * `AccessTab`: it is the platform's own record that the last route emission
 * never reached the proxy, and without it the owner has no way to know their
 * app reads as shared while actually serving ungated.
 *
 * A 403 with `error.details.reason === 'sharing_disabled'` is not a failure
 * to render as an error — it is the platform-wide toggle being off, a
 * first-run state the owner cannot act on except by asking an administrator.
 * It is checked BEFORE the owner ever gets to type a username, not surfaced
 * only once they try to submit.
 */

/**
 * Owner-safe wording for each `AccessGateBlocker` code (see
 * `src/managers/guardrail/access-gate.ts`). Deliberately shorter and less
 * specific than the admin route's `reasons` sentences — these describe what
 * the owner can infer ("needs HTTPS"), never platform internals an owner has
 * no way to act on ("ICC-disabled network could not be recreated").
 */
const BLOCKER_COPY: Record<string, string> = {
  'feature-disabled': 'The sign-in gate feature is switched off on this platform.',
  'isolation-not-docker': "This platform's current configuration can't enforce a sign-in gate.",
  'auth-disabled': 'Sign-in is switched off on this platform, so there is no one to gate access to.',
  'no-https': "This app isn't served over HTTPS, which a sign-in gate requires.",
  'tenant-network-shared': "This platform's network configuration can't currently support a sign-in gate.",
  'monorepo-group-child':
    'This app is part of a group of services that share one address — the group would need to be gated as a whole.',
  'monorepo-group-container': "This app doesn't serve traffic itself, so it can't carry a sign-in gate.",
  'no-public-url': "This app doesn't have a public address yet.",
  'multi-hostname': 'This app is reachable at more than one address, which a sign-in gate doesn’t support yet.',
  'api-port-unusable': "The platform's own API isn't reachable right now.",
  'invalid-app-name': "This app's name isn't compatible with a sign-in gate.",
};

function blockerCopy(code: string): string {
  return BLOCKER_COPY[code] ?? "This app can't be gated right now.";
}

/**
 * The platform-wide sharing toggle is read LIVE by every `/share` route, not
 * just GET (see the route file header) — an admin can flip it off while this
 * panel is already open. Every response that can carry the refusal, not just
 * the initial load, is checked against it so a write lands on the same
 * first-run panel `load` shows rather than a red banner the owner keeps
 * retrying against.
 */
function isSharingDisabled(res: { status: number; error?: unknown }): boolean {
  return shareRefusal(res) === 'sharing';
}

function ShareCard({ appName }: { appName: string }) {
  const [view, setView] = useState<ShareView | null>(null);
  // Distinct from a generic load failure — see the file header on why this is
  // a first-run experience, not an error state.
  const [sharingDisabled, setSharingDisabled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await apiJsonWithStatus<ShareView>(`/apps/${appName}/share`);
    if (res.success && res.data) {
      setView(res.data);
      setSharingDisabled(false);
      setLoadError(null);
      return;
    }
    if (isSharingDisabled(res)) {
      setSharingDisabled(true);
      setView(null);
      setLoadError(null);
      return;
    }
    setSharingDisabled(false);
    setView(null);
    setLoadError(res.error?.message || 'Could not load sharing settings.');
  }, [appName]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The once-only invitation link — see `InviteLinkPanel` for why it is shown at all. */
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);
  const [guestEmail, setGuestEmail] = useState('');
  /** Set when the platform refuses the `{ email }` branch, so the field stops offering it. */
  const [guestInvitesDisabled, setGuestInvitesDisabled] = useState(false);

  // None of this survives a change of app. `AppDetailPage` does not remount on
  // a name change, so a live single-use invitation minted for app A would
  // otherwise stay rendered under app B's heading, next to copy telling the
  // owner to send it to someone — a working guest credential, mis-delivered to
  // the wrong application. A refusal learned from one app's toggle read is
  // likewise not a fact about the next one.
  useEffect(() => {
    setInviteLink(null);
    setGuestEmail('');
    setGuestInvitesDisabled(false);
    setBanner(null);
  }, [appName]);

  const grant = async (targetUsername: string, gateApp: boolean) => {
    setSaving(true);
    setBanner(null);
    const res = await apiJsonWithStatus<{
      message: string;
      ownGrants: OwnGrant[];
      othersGrantedCount: number;
      applyError?: string;
    }>(`/apps/${appName}/share`, {
      method: 'POST',
      ...jsonBody({ username: targetUsername, ...(gateApp ? { gateApp: true } : {}) }),
    });
    setSaving(false);

    if (!res.success) {
      if (isSharingDisabled(res)) {
        setSharingDisabled(true);
        setView(null);
        return;
      }
      setBanner({ kind: 'error', text: res.error?.message || 'Could not share this app.' });
      return;
    }
    setUsername('');
    // A grant can succeed and still not reach the proxy — same distinction
    // AccessTab's save makes, for the same reason: "shared" alone would be
    // the lie the `gateApplied` signal exists to prevent.
    setBanner(
      res.data?.applyError
        ? { kind: 'error', text: gateNotReappliedText('Shared', res.data.applyError) }
        : { kind: 'ok', text: res.data?.message || `Shared with ${targetUsername}.` }
    );
    await load();
  };

  const handleGrant = () => {
    const trimmed = username.trim();
    if (!trimmed || !view) return;
    // The acknowledged-act rule (file header): a first share on an ungated
    // app is confirmed explicitly, and only then sent with `gateApp: true`.
    if (!view.policyPresent) {
      const confirmed = window.confirm(
        `${appName} isn't sign-in gated yet. Sharing it with '${trimmed}' will make it sign-in-only ` +
          `for everyone else — only an administrator can undo this. Continue?`
      );
      if (!confirmed) return;
      void grant(trimmed, true);
      return;
    }
    void grant(trimmed, false);
  };

  const revoke = async (userId: string, label: string) => {
    if (!window.confirm(`Revoke ${label}'s access to ${appName}?`)) return;
    setSaving(true);
    setBanner(null);
    const res = await apiJsonWithStatus<{ message: string; revoked: boolean; applyError?: string }>(
      `/apps/${appName}/share/${userId}`,
      { method: 'DELETE' }
    );
    setSaving(false);
    if (!res.success && isSharingDisabled(res)) {
      setSharingDisabled(true);
      setView(null);
      return;
    }
    setBanner(
      !res.success
        ? { kind: 'error', text: res.error?.message || 'Could not revoke access.' }
        : res.data?.applyError
          ? { kind: 'error', text: gateNotReappliedText('Revoked', res.data.applyError) }
          : { kind: 'ok', text: res.data?.message || 'Access revoked.' }
    );
    await load();
  };

  const invite = async (email: string, gateApp: boolean) => {
    setSaving(true);
    setBanner(null);
    setInviteLink(null);
    const res = await apiJsonWithStatus<{
      message: string;
      mailSent: boolean;
      inviteUrl?: string;
      applyError?: string;
    }>(`/apps/${appName}/share`, {
      method: 'POST',
      ...jsonBody({ email, ...(gateApp ? { gateApp: true } : {}) }),
    });
    setSaving(false);

    if (!res.success) {
      if (isSharingDisabled(res)) {
        setSharingDisabled(true);
        setView(null);
        return;
      }
      // The platform's own opt-in for the guest branch, separate from app
      // sharing — an admin may reasonably have one on and the other off.
      if ((res.error as { details?: { reason?: string } })?.details?.reason === 'guest_invites_disabled') {
        setGuestInvitesDisabled(true);
        setBanner({ kind: 'error', text: res.error?.message || 'Guest invitations are disabled.' });
        return;
      }
      setBanner({ kind: 'error', text: res.error?.message || 'Could not send that invitation.' });
      return;
    }

    setGuestEmail('');

    // Mail was never sent, so the owner has to deliver this themselves or
    // nothing happens (see `inviteSecretUrl` for why this is not simply "a url
    // came back").
    const url = inviteSecretUrl(res.data);

    // ADDITIVE, never an either/or. `applyError` fires on the write that
    // creates the policy and `inviteUrl` comes back when no mail was dialed —
    // so both arrive together on the single most likely case, a first invite
    // on a relay-less box. Branching dropped the secret (nothing stores it,
    // so it is unrecoverable) while telling the owner the person was invited.
    if (url) setInviteLink({ email, url });
    if (res.data?.applyError) {
      setBanner({ kind: 'error', text: gateNotReappliedText('Invited', res.data.applyError) });
    } else if (url) {
      setBanner(null);
    } else {
      setBanner({ kind: 'ok', text: res.data?.message || `Invitation sent to ${email}.` });
    }
    await load();
  };

  const handleInvite = () => {
    const trimmed = guestEmail.trim();
    if (!trimmed || !view) return;
    // The same acknowledged-act rule the username branch follows — a first
    // share on an ungated app is confirmed explicitly (file header).
    if (!view.policyPresent) {
      const confirmed = window.confirm(
        `${appName} isn't sign-in gated yet. Inviting '${trimmed}' will make it sign-in-only ` +
          `for everyone else — only an administrator can undo this. Continue?`
      );
      if (!confirmed) return;
      void invite(trimmed, true);
      return;
    }
    void invite(trimmed, false);
  };

  const revokeGuest = async (guestId: string, label: string) => {
    if (!window.confirm(`Revoke ${label}'s access to ${appName}?`)) return;
    setSaving(true);
    setBanner(null);
    setInviteLink(null);
    const res = await apiJsonWithStatus<{ message: string; revoked: boolean; applyError?: string }>(
      `/apps/${appName}/share/guests/${encodeURIComponent(guestId)}`,
      { method: 'DELETE' }
    );
    setSaving(false);
    if (!res.success && isSharingDisabled(res)) {
      setSharingDisabled(true);
      setView(null);
      return;
    }
    setBanner(
      !res.success
        ? { kind: 'error', text: res.error?.message || 'Could not revoke access.' }
        : res.data?.applyError
          ? { kind: 'error', text: gateNotReappliedText('Revoked', res.data.applyError) }
          : { kind: 'ok', text: res.data?.message || 'Access revoked.' }
    );
    await load();
  };

  // Platform-wide toggle is off — a first-run state, not a validation error,
  // shown before the owner ever gets to type a username.
  if (sharingDisabled) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <ShieldOff className="mt-0.5 h-5 w-5 opacity-50" />
          <div>
            <h3 className="font-semibold">Sharing isn&rsquo;t turned on</h3>
            <p className="mt-1 text-sm opacity-70">
              An administrator has not enabled owner-initiated app sharing on this platform. Ask an
              administrator to turn it on, or to grant access on your behalf.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="p-6">
        <p className="text-sm text-err">
          {loadError}
        </p>
      </Card>
    );
  }

  if (!view) {
    return (
      <Card className="p-6">
        <p className="text-sm opacity-70">Loading…</p>
      </Card>
    );
  }

  const gated = view.policyPresent;
  const misapplied = gated && view.gateApplied === false;
  const canGrant = view.enforceable;

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          {gated ? (
            misapplied ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-500" />
            ) : (
              <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-500" />
            )
          ) : (
            <ShieldOff className="mt-0.5 h-5 w-5 opacity-50" />
          )}
          <div className="flex-1">
            <h3 className="font-semibold">
              {!gated ? 'Open to anyone who can reach it' : misapplied ? 'Gate NOT applied' : 'Sign-in required'}
            </h3>

            {misapplied && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                The platform&rsquo;s last attempt to install the gate did not reach the proxy. This
                app is <strong>not</strong> actually being gated right now.
              </p>
            )}

            {gated && !view.enforced && !misapplied && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                A gate is recorded but is not being enforced on this platform.
              </p>
            )}

            {!view.enforceable && view.blockers.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm opacity-80">
                {view.blockers.map(b => (
                  <li key={b}>{blockerCopy(b)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="flex items-center gap-2 font-semibold">
          <Lock className="h-4 w-4" /> Who you&rsquo;ve shared it with
        </h3>
        <p className="mt-1 text-sm opacity-70">
          People you grant here can sign in and open this app. You can only see and manage the
          people you shared it with yourself.
        </p>

        {view.othersGrantedCount > 0 && (
          <p className="mt-2 text-sm opacity-70">
            {view.othersGrantedCount} more {view.othersGrantedCount === 1 ? 'person was' : 'people were'}{' '}
            granted access by an administrator.
          </p>
        )}

        {banner && (
          <div
            className={`mt-3 rounded px-3 py-2 text-sm ${
              banner.kind === 'error'
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {banner.text}
          </div>
        )}

        <div className="mt-4 space-y-1">
          {view.ownGrants.length === 0 ? (
            <p className="text-sm opacity-60">You haven&rsquo;t shared this app with anyone yet.</p>
          ) : (
            view.ownGrants.map(g => (
              <AccountGrantRow
                key={g.userId}
                grant={g}
                disabled={saving}
                onRevoke={(userId, label) => void revoke(userId, label)}
              />
            ))
          )}
        </div>

        {view.ownGuests.length > 0 && (
          <div className="mt-4 space-y-1 border-t pt-4">
            <p className="text-xs uppercase tracking-wide opacity-50">Invited by email</p>
            {view.ownGuests.map(g => (
              <GuestGrantRow
                key={g.guestId}
                guest={g}
                disabled={saving}
                onResend={email => void invite(email, false)}
                onRevoke={(guestId, label) => void revokeGuest(guestId, label)}
              />
            ))}
          </div>
        )}

        {inviteLink && (
          <InviteLinkPanel email={inviteLink.email} url={inviteLink.url} onResult={setBanner} />
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
          <label className="text-sm">
            <span className="opacity-60">Username</span>
            <Input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="teammate"
              disabled={saving || !canGrant}
            />
          </label>
          <Button onClick={handleGrant} disabled={saving || !canGrant || !username.trim()}>
            Share
          </Button>
        </div>

        {!guestInvitesDisabled && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="opacity-60">Or invite by email</span>
              <Input
                type="email"
                value={guestEmail}
                onChange={e => setGuestEmail(e.target.value)}
                placeholder="someone@example.com"
                disabled={saving || !canGrant}
              />
            </label>
            <Button onClick={handleInvite} disabled={saving || !canGrant || !guestEmail.trim()}>
              Invite
            </Button>
          </div>
        )}

        {!guestInvitesDisabled && (
          <p className="mt-2 text-xs opacity-60">
            Someone invited by email opens this app without a DROP account. Their invitation is
            single-use and expires.
          </p>
        )}

        {!canGrant && (
          <p className="mt-2 text-xs opacity-60">
            Sharing is unavailable until the issue above is resolved.
          </p>
        )}
      </Card>
    </div>
  );
}

export default ShareCard;
