import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, ShieldOff, UserPlus, Users, X } from 'lucide-react';
import { apiJsonWithStatus, jsonBody } from '../api/client';
import { getAuthHeaders } from '../hooks/useAuth';
import Card from './ui/Card';
import { asArray } from '../lib/api-shape';
import Button from './ui/Button';
import Input from './ui/Input';

/**
 * Access governance for one app (DROP-152).
 *
 * The reason this shows three things rather than a "gated / not gated" badge:
 * a policy being STORED and a policy being ENFORCED are different facts, and
 * the gap between them is what an operator needs to see.
 *
 *   enforceable — could this BOX carry a gate at all?
 *   enforced    — does this build put one in front of traffic?
 *   gateApplied — did the platform's last route emission reach the proxy?
 *
 * A capable box, a build with the emitter, and an emission the proxy rejected
 * would otherwise render as "protected" while every request walked straight
 * through. That state gets a warning, not a green shield.
 *
 * It is also a WRITE surface. The first version was read-only, which meant the
 * only way to gate an app was curl with an admin token — a governance control
 * the people it is for could not use.
 *
 * The guest-invite section at the bottom exists for the same reason. An admin
 * viewing an app gets THIS component, never `ShareCard` (AppDetailPage), and
 * `ShareCard` held the only invite-by-email control — so an operator with
 * `guest-invites` switched on could not invite anyone from the UI they
 * actually see, only with curl.
 *
 * It DUPLICATES ~40 lines of `ShareCard`'s guest branch rather than sharing
 * them, deliberately. Extracting would mean surgery on the shipped owner path
 * (its confirm dialog, its sharing-disabled first-run panel, its once-only
 * link box) for a change that does not otherwise touch it, and the two differ
 * where it counts: the copy here is admin-actionable (a refusal names the
 * toggle to flip) where `ShareCard`'s says "ask an administrator". Extract if
 * a third caller ever appears.
 *
 * The guest list is scoped and SAYS SO. `GET /apps/:name/share` reports guests
 * through `ownView`, which returns only the ones the CALLER invited; everyone
 * else's are a number. On this component — the full-disclosure surface for
 * accounts (allow-list, provenance, openers) — an unlabelled partial list
 * would read as complete and would not be. It is labelled "Guests you
 * invited" for that reason, and it is exactly the set this card can act on:
 * `DELETE /apps/:name/share/guests/:guestId` admits an admin against any
 * guest, but nothing in the UI would let one pick a guest they cannot see.
 *
 * A create-only control was the first shape of this, and it was wrong: an
 * admin could mint guest access here and then had no dashboard path to undo
 * it, in a component whose entire subject is who may open the app.
 */

interface AccessView {
  // `guests` is the WHOLE app's guest id list, which this route (unlike the
  // share view) returns unscoped. Ids only — no addresses — which is exactly
  // enough to report that guests this caller cannot list can still open the
  // app, and not enough to disclose who they are.
  access: { mode: string; allow: string[]; guests?: string[] } | null;
  enforced: boolean;
  enforceable: boolean;
  blockers: string[];
  reasons: string[];
  gateApplied: boolean | null;
  lastOpenedAt: string | null;
  recentOpeners: Array<{ userId: string; username: string; at: string }>;
  owner: string | null;
  reviewBy: string | null;
}

interface DirectoryUser {
  id: string;
  username: string;
  role: string;
}

/** One guest THIS caller invited — see the header on why the list is scoped. */
interface OwnGuest {
  guestId: string;
  email: string;
  disabled: boolean;
}

function AccessTab({ appName }: { appName: string }) {
  const [view, setView] = useState<AccessView | null>(null);
  const [status, setStatus] = useState<number>(0);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewBy, setReviewBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [guestEmail, setGuestEmail] = useState('');
  /**
   * The invite section keeps its OWN banner rather than sharing the allow-list
   * one above: they sit in different cards, and a "policy saved" message
   * appearing next to the invite box (or the reverse) reports the wrong write.
   */
  const [inviteBanner, setInviteBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(
    null
  );
  /**
   * The invitation link, shown ONLY when the server says no mail was sent —
   * no relay configured, or the mailer refused the input, so nothing was
   * dialed. The secret exists in plaintext exactly once, in that response;
   * without showing it a platform with no relay cannot invite anyone at all.
   */
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);
  /**
   * Which platform toggle refused the invite, if one did. Two SEPARATE
   * settings gate this: `app-sharing` is checked first (it guards every
   * `/share` route), then `guest-invites` guards the `{ email }` branch — so
   * guest invites can be on and still refuse because sharing is off. Learned
   * from the refusal rather than pre-fetched: an extra settings read on every
   * Access tab open, to pre-hide a control an admin can turn on in two clicks,
   * is not worth it.
   */
  const [inviteBlockedBy, setInviteBlockedBy] = useState<'sharing' | 'guests' | null>(null);
  /**
   * THREE states, not an array. An unreadable guest list rendered as an empty
   * one is an affirmative "nobody has guest access" on the one screen whose
   * subject is who may open the app — and the read fails for ordinary reasons
   * (an expired session, the rate limiter, the app-sharing toggle) while the
   * grants it could not read stay live.
   */
  const [guestList, setGuestList] = useState<
    { kind: 'loading' } | { kind: 'ok'; items: OwnGuest[] } | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  /**
   * Which app the mounted component is currently about. `AppDetailPage` does
   * not remount on a name change, so without this an in-flight response for
   * app A can land under app B — and the payload here carries INVITEE EMAIL
   * ADDRESSES and drives a Revoke button.
   */
  const currentApp = useRef(appName);
  useEffect(() => {
    currentApp.current = appName;
  }, [appName]);

  /**
   * `reseedForm: false` refreshes the READ-ONLY view without touching the
   * allow-list form. Used by the guest-invite path, which has to re-read the
   * gate (its write can create the policy) but must not re-tick a checkbox the
   * admin has just un-ticked and not yet saved — that would silently abandon
   * an access REMOVAL, the one direction of this that is not fail-safe.
   */
  const load = useCallback(
    async (opts?: { reseedForm?: boolean }) => {
      const forApp = appName;
      const res = await apiJsonWithStatus<AccessView>(`/apps/${appName}/access`);
      if (currentApp.current !== forApp) return;
      setStatus(res.status);
      if (res.success && res.data) {
        setView(res.data);
        if (opts?.reseedForm === false) return;
        // The allow-list is the SOURCE; the checkboxes mirror it. Re-seeding on
        // every load means a failed save cannot leave the form claiming a state
        // the server never accepted.
        // asArray, not `?? []`: `new Set` throws on a non-iterable, and a `{}`
        // there is neither null nor undefined so the default never fires
        // (DROP-237).
        setSelected(new Set(asArray<string>(res.data.access?.allow)));
        setReviewBy(res.data.reviewBy ? res.data.reviewBy.slice(0, 10) : '');
      }
    },
    [appName]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The guest slice comes from the SHARE view — `GET /access` reports the
   * allow-list and knows nothing about guests. Only `ownGuests` is read from
   * it; see the header on why that scoping is the honest one here.
   *
   * This GET is also the one guest-related route an admin does NOT bypass the
   * app-sharing toggle on (the revokes do, so removal is always possible), so
   * its refusal is how the panel learns the toggle is off before anyone types
   * an address. It refuses the READ only — the count below it, taken from
   * `GET /access`, still reports that guests exist.
   */
  const loadGuests = useCallback(async () => {
    const forApp = appName;
    const res = await apiJsonWithStatus<{ ownGuests?: OwnGuest[] }>(`/apps/${appName}/share`);
    if (currentApp.current !== forApp) return;
    if (res.success && res.data) {
      setGuestList({ kind: 'ok', items: asArray<OwnGuest>(res.data.ownGuests) });
      // Clear a stale sharing block, never a `guests` one — this route says
      // nothing about the guest-invites toggle.
      setInviteBlockedBy(prev => (prev === 'sharing' ? null : prev));
      return;
    }
    const reason = (res.error as { details?: { reason?: string } } | undefined)?.details?.reason;
    if (res.status === 403 && reason === 'sharing_disabled') {
      setInviteBlockedBy('sharing');
      setGuestList({
        kind: 'error',
        message: 'Guests cannot be listed while owner sharing is switched off.',
      });
      return;
    }
    setGuestList({ kind: 'error', message: res.error?.message || 'Could not read the guest list.' });
  }, [appName]);

  useEffect(() => {
    void loadGuests();
  }, [loadGuests]);

  // Invite state is per-APP, and none of it survives a change of app: a live
  // invitation secret rendered under another app's Access tab invites a
  // mis-delivery, and a refusal learned from one app's toggle read is not a
  // fact about the next one (it also un-sticks the panel once an admin flips
  // the toggle back on).
  useEffect(() => {
    setInviteLink(null);
    setInviteBanner(null);
    setInviteBlockedBy(null);
    setGuestEmail('');
    // The list carries app A's invitees' EMAIL ADDRESSES; leaving it up under
    // app B's heading is the same misattribution, one field further in.
    setGuestList({ kind: 'loading' });
  }, [appName]);

  useEffect(() => {
    void (async () => {
      // The API validates ids, not usernames — a username can be reassigned —
      // so the picker has to resolve them here.
      try {
        const res = await fetch('/api/v1/auth/users', { headers: getAuthHeaders() });
        const json = (await res.json()) as { success: boolean; data?: DirectoryUser[] };
        if (json.success) setUsers(asArray(json.data));
      } catch {
        // A missing directory degrades the picker, not the page.
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setBanner(null);
    // Any write to the policy can invalidate a still-displayed invitation
    // link, and the box next to it says "send this to <person>". Drop it
    // rather than leave a credential on screen that may no longer admit
    // anyone (`removeGate` does the same, harder).
    setInviteLink(null);
    const res = await apiJsonWithStatus<{ enforced: boolean; applyError?: string }>(
      `/apps/${appName}/access`,
      {
        method: 'PUT',
        ...jsonBody({
          allow: [...selected],
          ...(reviewBy ? { reviewBy } : {}),
        }),
      }
    );
    setSaving(false);

    if (res.status === 409) {
      // A structured refusal: the platform cannot enforce a gate here. Render
      // the reasons it gave rather than a generic failure — each one names
      // something an operator can act on.
      const reasons = (res.error as { details?: { reasons?: string[] } })?.details?.reasons;
      setBanner({
        kind: 'error',
        text: reasons?.length
          ? `This platform cannot enforce a gate here: ${reasons.join('; ')}`
          : res.error?.message || 'This platform cannot enforce a gate here.',
      });
      return;
    }
    if (!res.success) {
      setBanner({ kind: 'error', text: res.error?.message || 'Could not save the access policy.' });
      return;
    }
    // A save can succeed and still not reach the proxy — the API says so, and
    // saying "saved" alone would be the same lie the three-signal display
    // exists to prevent.
    setBanner(
      res.data?.applyError
        ? { kind: 'error', text: `Saved, but the route was not re-emitted: ${res.data.applyError}` }
        : { kind: 'ok', text: 'Access policy saved.' }
    );
    await load();
  };

  const removeGate = async () => {
    // Distinct from an empty allow-list, which still gates the app to its owner
    // and admins. Removing means anyone who can reach it can open it.
    if (!window.confirm(`Remove the sign-in gate from ${appName}? Anyone who can reach it will be able to open it.`)) {
      return;
    }
    setSaving(true);
    setBanner(null);
    // Removing the policy takes the guest grants with it, so any link shown
    // above would admit nobody.
    setInviteLink(null);
    const res = await apiJsonWithStatus(`/apps/${appName}/access`, { method: 'DELETE' });
    setSaving(false);
    setBanner(
      res.success
        ? { kind: 'ok', text: 'Access gate removed.' }
        : { kind: 'error', text: res.error?.message || 'Could not remove the gate.' }
    );
    await load();
    // Clearing the policy takes the guest grants with it. Without this the
    // list keeps naming people who can no longer open the app, and pressing
    // Revoke on one answers "there was nothing to revoke".
    await loadGuests();
  };

  const invite = async (email: string, gateApp: boolean) => {
    setSaving(true);
    setInviteBanner(null);
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
      const reason = (res.error as { details?: { reason?: string } } | undefined)?.details?.reason;
      if (res.status === 403 && (reason === 'sharing_disabled' || reason === 'guest_invites_disabled')) {
        setInviteBlockedBy(reason === 'sharing_disabled' ? 'sharing' : 'guests');
        return;
      }
      setInviteBanner({
        kind: 'error',
        text: res.error?.message || 'Could not send that invitation.',
      });
      return;
    }

    setGuestEmail('');

    // `mailSent === false`, not merely "a url came back": the server makes the
    // two equivalent today, and asserting the invariant here means a response
    // that ever carried both would withhold the secret rather than display a
    // link to an invitation that WAS delivered.
    const url = res.data?.mailSent === false ? res.data?.inviteUrl : undefined;

    // ADDITIVE, never an either/or. `applyError` fires on `justCreated` and
    // `inviteUrl` comes back when no mail was dialed — so both arrive together
    // on the single most likely case, the first invite on a relay-less box.
    // Branching would drop the secret (unrecoverable: nothing stores it) while
    // telling the admin the person was invited.
    if (url) setInviteLink({ email, url });
    if (res.data?.applyError) {
      setInviteBanner({
        kind: 'error',
        text: `Invited, but the gate was not re-applied: ${res.data.applyError}`,
      });
    } else if (!url) {
      setInviteBanner({ kind: 'ok', text: res.data?.message || `Invitation sent to ${email}.` });
    }
    // An invite carrying `gateApp` creates the policy server-side, so the gate
    // display above is stale until this runs. The FORM is deliberately left
    // alone (see `load`) — this write never touches `allow`.
    await load({ reseedForm: false });
    await loadGuests();
  };

  const revokeGuest = async (guestId: string, label: string) => {
    if (!window.confirm(`Revoke ${label}'s access to ${appName}?`)) return;
    setSaving(true);
    setInviteBanner(null);
    // Whatever link is on screen may be this guest's — same reason `save` and
    // `removeGate` drop it.
    setInviteLink(null);
    const res = await apiJsonWithStatus<{ message: string; revoked: boolean; applyError?: string }>(
      `/apps/${appName}/share/guests/${encodeURIComponent(guestId)}`,
      { method: 'DELETE' }
    );
    setSaving(false);

    if (!res.success) {
      setInviteBanner({
        kind: 'error',
        text: res.error?.message || 'Could not revoke that guest.',
      });
    } else if (res.data?.revoked === false) {
      // A 200 that revoked NOTHING. The route answers this way rather than
      // disclosing whether the id exists, so reporting it as a revoke would
      // be a claim the list is about to contradict.
      setInviteBanner({ kind: 'error', text: res.data.message || 'There was nothing to revoke.' });
    } else {
      setInviteBanner(
        res.data?.applyError
          ? { kind: 'error', text: `Revoked, but the gate was not re-applied: ${res.data.applyError}` }
          : { kind: 'ok', text: `${label} can no longer open ${appName}.` }
      );
    }
    await loadGuests();
  };

  const handleInvite = () => {
    const trimmed = guestEmail.trim();
    if (!trimmed || !view) return;
    // The acknowledged-act rule `ShareCard` follows: a first admission on an
    // ungated app is confirmed explicitly, and only then sent with
    // `gateApp: true`.
    if (view.access === null) {
      const confirmed = window.confirm(
        `${appName} isn't sign-in gated yet. Inviting '${trimmed}' will make it sign-in-only ` +
          `for everyone else. Continue?`
      );
      if (!confirmed) return;
      void invite(trimmed, true);
      return;
    }
    void invite(trimmed, false);
  };

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Admin-only: the visitor set is personal data about third parties.
  if (status === 403) {
    return (
      <Card className="p-6">
        <p className="text-sm opacity-70">Access governance is visible to administrators.</p>
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

  const gated = view.access !== null;
  const misapplied = gated && view.gateApplied === false;
  /**
   * Guests on this app that the list above does not show — someone else's
   * invitees, or all of them when the share read was refused. Counted from
   * the policy's own `guests` ids so it stays truthful in both cases; floored
   * at zero because the two reads are independent and can disagree in flight.
   */
  const unlistedGuests = Math.max(
    0,
    (view.access?.guests?.length ?? 0) - (guestList.kind === 'ok' ? guestList.items.length : 0)
  );

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
              {!gated
                ? 'Open to anyone who can reach it'
                : misapplied
                  ? 'Gate NOT applied'
                  : 'Sign-in required'}
            </h3>

            {misapplied && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                A policy is recorded, but the platform&rsquo;s last attempt to install the gate did
                not reach the proxy. Traffic is <strong>not</strong> being gated.
              </p>
            )}

            {gated && !view.enforced && !misapplied && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                A policy is recorded but is not being enforced on this platform.
              </p>
            )}

            {!view.enforceable && view.reasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm opacity-80">
                {view.reasons.map(r => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <dl className="mt-5 grid gap-4 border-t pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="opacity-60">Owner</dt>
            <dd className="mt-0.5 font-medium">{view.owner ?? 'unowned'}</dd>
          </div>
          <div>
            <dt className="opacity-60">Review by</dt>
            <dd className="mt-0.5 font-medium">
              {view.reviewBy ? new Date(view.reviewBy).toLocaleDateString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="opacity-60">Last opened</dt>
            <dd className="mt-0.5 font-medium">
              {view.lastOpenedAt ? new Date(view.lastOpenedAt).toLocaleString() : 'never'}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-6">
        <h3 className="flex items-center gap-2 font-semibold">
          <Lock className="h-4 w-4" /> Who may open it
        </h3>
        <p className="mt-1 text-sm opacity-70">
          The owner and administrators can always open this app. Everyone else must be listed here
          — or invited by email below, which admits someone with no account, so they never appear
          in this list.
        </p>

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

        <div className="mt-4 max-h-64 space-y-1 overflow-y-auto">
          {users.length === 0 ? (
            <p className="text-sm opacity-60">No other users to choose from.</p>
          ) : (
            users.map(u => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onChange={() => toggle(u.id)}
                  disabled={saving}
                />
                <span>{u.username}</span>
                <span className="opacity-50">{u.role}</span>
              </label>
            ))
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
          <label className="text-sm">
            <span className="opacity-60">Review by</span>
            <Input
              type="date"
              value={reviewBy}
              onChange={e => setReviewBy(e.target.value)}
              disabled={saving}
            />
          </label>
          <Button onClick={() => void save()} disabled={saving}>
            {gated ? 'Update gate' : 'Require sign-in'}
          </Button>
          {gated && (
            <Button variant="danger" onClick={() => void removeGate()} disabled={saving}>
              Remove gate
            </Button>
          )}
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="flex items-center gap-2 font-semibold">
          <UserPlus className="h-4 w-4" /> Invite someone without an account
        </h3>
        <p className="mt-1 text-sm opacity-70">
          They get a single-use emailed invitation and open this app with no DROP account, no
          password, and no signup. Invitations are single-use and expire on their own; revoking one
          takes effect immediately.
        </p>

        {inviteBanner && (
          <div
            className={`mt-3 rounded px-3 py-2 text-sm ${
              inviteBanner.kind === 'error'
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {inviteBanner.text}
          </div>
        )}

        {/* The list, its Revoke buttons and the banner sit OUTSIDE the
            blocked branch below, on purpose. `app-sharing` off refuses the
            share READ but never a revoke (`ADMIN_MAY_BYPASS_TOGGLE`), which
            is the API's own rule: an operator who switches the feature off
            during an incident must not thereby lose every lever for removing
            access. Hiding this whole section behind the toggle copy would
            reintroduce exactly that, and would swallow the confirmation of a
            revoke that had just succeeded. */}
        <div className="mt-4 space-y-1">
          {guestList.kind === 'loading' && <p className="text-sm opacity-60">Loading guests…</p>}

          {guestList.kind === 'error' && (
            // NOT "nobody has been invited" — the read failed, and the grants
            // it could not read are still live.
            <p className="text-sm text-amber-600 dark:text-amber-400">{guestList.message}</p>
          )}

          {guestList.kind === 'ok' &&
            (guestList.items.length === 0 ? (
              <p className="text-sm opacity-60">
                You haven&rsquo;t invited anyone by email to this app yet.
              </p>
            ) : (
              <>
                {/* Scoped, and says so — the header explains why an
                    unlabelled list would be the wrong shape here. */}
                <p className="text-xs uppercase tracking-wide opacity-50">Guests you invited</p>
                {guestList.items.map(g => (
                  <div
                    key={g.guestId}
                    className="flex items-center justify-between gap-2 py-1 text-sm"
                  >
                    <span className={g.disabled ? 'opacity-50 line-through' : undefined}>
                      {g.email || g.guestId}
                      {g.disabled && (
                        <span className="ml-2 text-xs opacity-70 no-underline">
                          disabled by an administrator
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {/* Resend is the SAME call as the first invite: the
                          address resolves to the same guest record and a
                          fresh single-use link is minted. It is the only
                          recovery path for a lost or expired invitation,
                          because the secret is never stored. Not offered
                          for a disabled guest — that record is an
                          administrator's decision. */}
                      {!g.disabled && (
                        <button
                          onClick={() => void invite(g.email, false)}
                          className="text-xs transition-opacity hover:opacity-70 text-faint"
                          disabled={saving || !g.email}
                          aria-label={`Resend invitation to ${g.email || g.guestId}`}
                        >
                          Resend
                        </button>
                      )}
                      <button
                        onClick={() => void revokeGuest(g.guestId, g.email || g.guestId)}
                        className="transition-opacity hover:opacity-70 text-faint"
                        disabled={saving}
                        aria-label={`Revoke access for ${g.email || g.guestId}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </span>
                  </div>
                ))}
              </>
            ))}

          {/* Ids from `GET /access`, which returns the WHOLE guest list —
              so an admin is told that guests they cannot list can open this
              app, even when the share read above was refused outright. */}
          {unlistedGuests > 0 && (
            <p className="pt-1 text-xs opacity-60">
              {unlistedGuests === 1
                ? '1 guest can open this app who is not listed here'
                : `${unlistedGuests} guests can open this app who are not listed here`}{' '}
              — invited by someone else, or not readable right now. Revoking one is{' '}
              <code className="text-xs">DELETE /apps/{appName}/share/guests/&lt;id&gt;</code>.
            </p>
          )}
        </div>

        {inviteLink && (
          <div className="mt-3 rounded border px-3 py-2 text-sm border-line">
            <p className="font-medium">No email was sent</p>
            <p className="mt-1 text-xs opacity-70">
              This platform has no outgoing mail configured, so you need to send{' '}
              {inviteLink.email} this link yourself. It can only be used once, and it will not
              be shown again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="text"
                readOnly
                value={inviteLink.url}
                onFocus={e => e.target.select()}
              />
              <Button
                onClick={() => {
                  // Never claim "copied" without checking. A dashboard on
                  // plain HTTP — the same dev/LAN box that, having no
                  // relay, is the only kind that ever sees this link —
                  // has no `navigator.clipboard` at all, and the admin
                  // would go and paste whatever was there before. The
                  // secret is not recoverable.
                  const copying = navigator.clipboard?.writeText(inviteLink.url);
                  if (!copying) {
                    setInviteBanner({
                      kind: 'error',
                      text: 'This browser will not let the page copy for you — select the link and press Ctrl-C.',
                    });
                    return;
                  }
                  void copying.then(
                    () => setInviteBanner({ kind: 'ok', text: 'Invitation link copied.' }),
                    () =>
                      setInviteBanner({
                        kind: 'error',
                        text: 'Could not copy — select the link and press Ctrl-C.',
                      })
                  );
                }}
              >
                Copy
              </Button>
              <Button variant="ghost" onClick={() => setInviteLink(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* Only the FORM is replaced when a platform toggle refuses. */}
        {inviteBlockedBy ? (
          <p className="mt-4 border-t pt-4 text-sm opacity-70">
            {inviteBlockedBy === 'guests'
              ? 'Guest invitations are switched off for this platform. Turn on “Let owners invite guests by email” under Settings → Platform.'
              : 'Owner-initiated sharing is switched off for this platform, and invitations go through the same route. Turning on “Let owners share their apps” under Settings → Platform re-enables it — that also lets every app owner share their own apps.'}
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              <label className="text-sm">
                <span className="opacity-60">Email address</span>
                <Input
                  type="email"
                  value={guestEmail}
                  onChange={e => setGuestEmail(e.target.value)}
                  placeholder="someone@example.com"
                  disabled={saving || !view.enforceable}
                />
              </label>
              <Button
                onClick={handleInvite}
                disabled={saving || !view.enforceable || !guestEmail.trim()}
              >
                Invite
              </Button>
            </div>

            <p className="mt-2 text-xs opacity-60">
              Re-entering an address that has already been invited sends a fresh invitation — that
              is the only way to replace a lost or expired one, because the link is never stored.
            </p>

            {!view.enforceable && (
              <p className="mt-2 text-xs opacity-60">
                Invitations are unavailable while this platform cannot enforce a gate here.
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="p-6">
        <h3 className="flex items-center gap-2 font-semibold">
          <Users className="h-4 w-4" /> Who has opened it
        </h3>
        {view.recentOpeners.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">No recorded sign-ins.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {view.recentOpeners.map(o => (
              <li key={o.userId} className="flex justify-between gap-4">
                <span>{o.username}</span>
                <span className="opacity-60">{new Date(o.at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default AccessTab;
