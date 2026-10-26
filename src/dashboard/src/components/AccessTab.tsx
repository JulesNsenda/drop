import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, ShieldOff, UserPlus, Users } from 'lucide-react';
import { apiJsonWithStatus, jsonBody } from '../api/client';
import { getAuthHeaders } from '../hooks/useAuth';
import Card from './ui/Card';
import { asArray } from '../lib/api-shape';
import Button from './ui/Button';
import Input from './ui/Input';
import InviteLinkPanel from './InviteLinkPanel';
import { AccountGrantRow, GuestGrantRow } from './ShareGrantRows';
import {
  gateNotReappliedText,
  inviteSecretUrl,
  shareRefusal,
  type OwnGrant,
  type OwnGuest,
} from '../lib/app-share';

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
 * The "Share this app" card at the bottom exists for the same reason. An
 * admin viewing an app gets THIS component, never `ShareCard`
 * (AppDetailPage), and `ShareCard` held the ONLY controls for both halves of
 * `/apps/:name/share` — so an operator with the feature switched on could not
 * share or invite anyone from the UI they actually see, only with curl.
 *
 * It reaches the same two routes as `ShareCard`, and the pieces where the two
 * are genuinely identical now live in one place: the wire contract in
 * `lib/app-share.ts` (root jest reaches it there; nothing executes a
 * component), and the row and once-only-link markup in `ShareGrantRows` /
 * `InviteLinkPanel`. What stays local is what genuinely differs — the copy
 * here is admin-actionable (a refusal names the toggle to flip) where
 * `ShareCard`'s says "ask an administrator", the confirm text drops the
 * "only an administrator can undo this" clause that is meaningless to one,
 * and the reads below are three-state where `ShareCard`'s are not.
 *
 * Sharing sits BESIDE the allow-list rather than replacing it, and they are
 * not the same control. The allow-list is the complete, admin-authored
 * governance set; a share carries the grantor's name (`grantedBy`) and is
 * revocable one entry at a time. Both write `access.allow`, which is why
 * every write here re-reads the gate — and why a grant seeds its id into the
 * checkbox form, so the admin's next "Update gate" cannot silently revoke the
 * person they just shared with.
 *
 * The two lists are scoped and SAY SO. `GET /apps/:name/share` reports both
 * through `ownView`, which returns only the grants and guests the CALLER
 * made; everyone else's are a number. On this component — the
 * full-disclosure surface for accounts (allow-list, provenance, openers) — an
 * unlabelled partial list would read as complete and would not be. They are
 * labelled "Shared by you" and "Guests you invited" for that reason, and they
 * are exactly the sets this card can act on: the DELETEs admit an admin
 * against any entry, but nothing in the UI would let one pick an entry they
 * cannot see. `othersGrantedCount` is deliberately NOT rendered — unlike an
 * owner, an admin already has the complete allow-list one card up, so a count
 * of "others" would restate it worse.
 *
 * A create-only control was the first shape of this, and it was wrong: an
 * admin could mint access here and then had no dashboard path to undo it, in
 * a component whose entire subject is who may open the app.
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

function AccessTab({ appName }: { appName: string }) {
  const [view, setView] = useState<AccessView | null>(null);
  const [status, setStatus] = useState<number>(0);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewBy, setReviewBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [guestEmail, setGuestEmail] = useState('');
  const [username, setUsername] = useState('');
  /**
   * The share card keeps its OWN banner rather than sharing the allow-list one
   * above: they sit in different cards, and a "policy saved" message appearing
   * next to the invite box (or the reverse) reports the wrong write. Both
   * halves of the card share this one — they are the same feature, the same
   * route and the same toggle, and a share confirmation appearing under the
   * email field is not a misattribution the way the allow-list's is.
   */
  const [shareBanner, setShareBanner] = useState<{ kind: 'error' | 'ok'; text: string } | null>(
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
   * THREE states, not two arrays. An unreadable list rendered as an empty one
   * is an affirmative "nobody has access" on the one screen whose subject is
   * who may open the app — and the read fails for ordinary reasons (an expired
   * session, the rate limiter, the app-sharing toggle) while the grants it
   * could not read stay live.
   *
   * Accounts and guests come from ONE response and live in ONE state for that
   * reason: two states fed by a single read can go independently stale, and
   * the failure mode is a list that says "nobody" while the other says
   * otherwise.
   */
  const [shareList, setShareList] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; grants: OwnGrant[]; guests: OwnGuest[] }
    | { kind: 'error'; message: string }
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
   * Both lists come from the SHARE view — `GET /access` reports the allow-list
   * and knows nothing about guests, and nothing about which account grants
   * this caller authored. Only the caller's own slices are read from it; see
   * the header on why that scoping is the honest one here.
   *
   * This GET is also the one `/share` route an admin does NOT bypass the
   * app-sharing toggle on (the revokes do, so removal is always possible), so
   * its refusal is how the panel learns the toggle is off before anyone types
   * a username or an address. It refuses the READ only — the count below it,
   * taken from `GET /access`, still reports that guests exist, and the
   * allow-list card above still shows every account grant.
   */
  const loadShareView = useCallback(async () => {
    const forApp = appName;
    const res = await apiJsonWithStatus<{ ownGrants?: OwnGrant[]; ownGuests?: OwnGuest[] }>(
      `/apps/${appName}/share`
    );
    if (currentApp.current !== forApp) return;
    if (res.success && res.data) {
      setShareList({
        kind: 'ok',
        grants: asArray<OwnGrant>(res.data.ownGrants),
        guests: asArray<OwnGuest>(res.data.ownGuests),
      });
      // Clear a stale sharing block, never a `guests` one — this route says
      // nothing about the guest-invites toggle.
      setInviteBlockedBy(prev => (prev === 'sharing' ? null : prev));
      return;
    }
    if (shareRefusal(res) === 'sharing') {
      setInviteBlockedBy('sharing');
      setShareList({
        kind: 'error',
        message: 'Shares and guests cannot be listed while owner sharing is switched off.',
      });
      return;
    }
    setShareList({
      kind: 'error',
      message: res.error?.message || 'Could not read who this app has been shared with.',
    });
  }, [appName]);

  useEffect(() => {
    void loadShareView();
  }, [loadShareView]);

  // Invite state is per-APP, and none of it survives a change of app: a live
  // invitation secret rendered under another app's Access tab invites a
  // mis-delivery, and a refusal learned from one app's toggle read is not a
  // fact about the next one (it also un-sticks the panel once an admin flips
  // the toggle back on).
  useEffect(() => {
    setInviteLink(null);
    setShareBanner(null);
    setInviteBlockedBy(null);
    setGuestEmail('');
    setUsername('');
    // The list carries app A's invitees' EMAIL ADDRESSES; leaving it up under
    // app B's heading is the same misattribution, one field further in.
    setShareList({ kind: 'loading' });
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
    // anyone (`removeGate` does the same, harder). The share banner goes with
    // it for the same reason one step further out: "Shared with alice." is a
    // claim about who can open this app, and this write may have just ended
    // that.
    setInviteLink(null);
    setShareBanner(null);
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
    // Removing the policy takes every grant with it, so any link shown above
    // would admit nobody — and any "Shared with …" confirmation beside it is
    // about to be false.
    setInviteLink(null);
    setShareBanner(null);
    const res = await apiJsonWithStatus(`/apps/${appName}/access`, { method: 'DELETE' });
    setSaving(false);
    setBanner(
      res.success
        ? { kind: 'ok', text: 'Access gate removed.' }
        : { kind: 'error', text: res.error?.message || 'Could not remove the gate.' }
    );
    await load();
    // Clearing the policy takes every grant with it. Without this the lists
    // keep naming people who can no longer open the app, and pressing Revoke
    // on one answers "there was nothing to revoke".
    await loadShareView();
  };

  /**
   * Share with a DROP account.
   *
   * `POST /share` writes the target into `access.allow` server-side, which the
   * checkbox form above mirrors — so the ids that came back are seeded into
   * `selected` here. Without that, the admin's next "Update gate" sends an
   * allow-list that omits the person they just shared with and silently
   * revokes them.
   *
   * Seeding ALL of `ownGrants`, not just the new id, is deliberate: the
   * response does not name the target, and re-ticking a grant of the admin's
   * own that they had un-ticked-but-not-saved errs toward keeping access,
   * which is the safe direction. Silent removal is the one that is not.
   */
  const grant = async (targetUsername: string, gateApp: boolean) => {
    setSaving(true);
    setShareBanner(null);
    // Any write to the policy can invalidate a still-displayed invitation
    // link, and the box next to it says "send this to <person>".
    setInviteLink(null);
    const res = await apiJsonWithStatus<{
      message: string;
      ownGrants: OwnGrant[];
      applyError?: string;
    }>(`/apps/${appName}/share`, {
      method: 'POST',
      ...jsonBody({ username: targetUsername, ...(gateApp ? { gateApp: true } : {}) }),
    });
    setSaving(false);

    if (!res.success) {
      if (shareRefusal(res) === 'sharing') {
        setInviteBlockedBy('sharing');
        return;
      }
      setShareBanner({ kind: 'error', text: res.error?.message || 'Could not share this app.' });
      return;
    }

    setUsername('');
    const granted = asArray<OwnGrant>(res.data?.ownGrants);
    if (granted.length > 0) {
      setSelected(prev => {
        const next = new Set(prev);
        for (const g of granted) next.add(g.userId);
        return next;
      });
    }
    setShareBanner(
      res.data?.applyError
        ? { kind: 'error', text: gateNotReappliedText('Shared', res.data.applyError) }
        : { kind: 'ok', text: res.data?.message || `Shared with ${targetUsername}.` }
    );
    // `reseedForm: false` — this write DID change `allow`, but re-seeding the
    // checkboxes from the server would discard an un-tick the admin has in
    // progress and not yet saved, silently abandoning an access REMOVAL. The
    // ids this write added are seeded above instead.
    await load({ reseedForm: false });
    await loadShareView();
  };

  const handleGrant = () => {
    const trimmed = username.trim();
    if (!trimmed || !view) return;
    // The acknowledged-act rule `ShareCard` follows: a first admission on an
    // ungated app is confirmed explicitly, and only then sent with
    // `gateApp: true`.
    if (view.access === null) {
      const confirmed = window.confirm(
        `${appName} isn't sign-in gated yet. Sharing it with '${trimmed}' will make it ` +
          `sign-in-only for everyone else. Continue?`
      );
      if (!confirmed) return;
      void grant(trimmed, true);
      return;
    }
    void grant(trimmed, false);
  };

  /**
   * Unlike the guest revoke, this one DOES remove an id from `access.allow` —
   * so the checkbox form has to drop it too, or the next save re-grants the
   * access just taken away.
   */
  const revokeGrant = async (userId: string, label: string) => {
    if (!window.confirm(`Revoke ${label}'s access to ${appName}?`)) return;
    setSaving(true);
    setShareBanner(null);
    setInviteLink(null);
    const res = await apiJsonWithStatus<{ message: string; revoked: boolean; applyError?: string }>(
      `/apps/${appName}/share/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );
    setSaving(false);

    if (!res.success) {
      setShareBanner({ kind: 'error', text: res.error?.message || 'Could not revoke access.' });
    } else {
      // Either way the id is NOT in `allow` server-side now, so the checkbox
      // drops it in both branches — the message is what differs.
      setSelected(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      if (res.data?.revoked === false) {
        // A 200 that revoked NOTHING — the same shape the guest revoke
        // answers with, and reporting it as a revoke would be a claim the
        // list is about to contradict.
        setShareBanner({ kind: 'error', text: res.data.message || 'There was nothing to revoke.' });
      } else {
        setShareBanner(
          res.data?.applyError
            ? { kind: 'error', text: gateNotReappliedText('Revoked', res.data.applyError) }
            : { kind: 'ok', text: `${label} can no longer open ${appName}.` }
        );
      }
    }
    await load({ reseedForm: false });
    await loadShareView();
  };

  const invite = async (email: string, gateApp: boolean) => {
    setSaving(true);
    setShareBanner(null);
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
      const refusal = shareRefusal(res);
      if (refusal) {
        setInviteBlockedBy(refusal);
        return;
      }
      setShareBanner({
        kind: 'error',
        text: res.error?.message || 'Could not send that invitation.',
      });
      return;
    }

    setGuestEmail('');

    // Not merely "a url came back" — see `inviteSecretUrl` for the invariant.
    const url = inviteSecretUrl(res.data);

    // ADDITIVE, never an either/or. `applyError` fires on `justCreated` and
    // `inviteUrl` comes back when no mail was dialed — so both arrive together
    // on the single most likely case, the first invite on a relay-less box.
    // Branching would drop the secret (unrecoverable: nothing stores it) while
    // telling the admin the person was invited.
    if (url) setInviteLink({ email, url });
    if (res.data?.applyError) {
      setShareBanner({
        kind: 'error',
        text: gateNotReappliedText('Invited', res.data.applyError),
      });
    } else if (!url) {
      setShareBanner({ kind: 'ok', text: res.data?.message || `Invitation sent to ${email}.` });
    }
    // An invite carrying `gateApp` creates the policy server-side, so the gate
    // display above is stale until this runs. The FORM is deliberately left
    // alone (see `load`) — this write never touches `allow`.
    await load({ reseedForm: false });
    await loadShareView();
  };

  const revokeGuest = async (guestId: string, label: string) => {
    if (!window.confirm(`Revoke ${label}'s access to ${appName}?`)) return;
    setSaving(true);
    setShareBanner(null);
    // Whatever link is on screen may be this guest's — same reason `save` and
    // `removeGate` drop it.
    setInviteLink(null);
    const res = await apiJsonWithStatus<{ message: string; revoked: boolean; applyError?: string }>(
      `/apps/${appName}/share/guests/${encodeURIComponent(guestId)}`,
      { method: 'DELETE' }
    );
    setSaving(false);

    if (!res.success) {
      setShareBanner({
        kind: 'error',
        text: res.error?.message || 'Could not revoke that guest.',
      });
    } else if (res.data?.revoked === false) {
      // A 200 that revoked NOTHING. The route answers this way rather than
      // disclosing whether the id exists, so reporting it as a revoke would
      // be a claim the list is about to contradict.
      setShareBanner({ kind: 'error', text: res.data.message || 'There was nothing to revoke.' });
    } else {
      setShareBanner(
        res.data?.applyError
          ? { kind: 'error', text: gateNotReappliedText('Revoked', res.data.applyError) }
          : { kind: 'ok', text: `${label} can no longer open ${appName}.` }
      );
    }
    await loadShareView();
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
    (view.access?.guests?.length ?? 0) - (shareList.kind === 'ok' ? shareList.guests.length : 0)
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
          — this is the complete list, including shares made below, which appear here under the
          name of whoever granted them. A guest invited by email has no account at all, so they
          never appear in it.
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
          <UserPlus className="h-4 w-4" /> Share this app
        </h3>
        <p className="mt-1 text-sm opacity-70">
          A share admits someone the same way the list above does, and appears there too — the
          difference is that it carries your name as the grantor, so you can take it back one
          entry at a time. Someone with no DROP account can be invited by email instead: they
          open this app with no account, no password and no signup, on a single-use invitation
          that expires on its own.
        </p>

        {shareBanner && (
          <div
            className={`mt-3 rounded px-3 py-2 text-sm ${
              shareBanner.kind === 'error'
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {shareBanner.text}
          </div>
        )}

        {/* The lists, their Revoke buttons and the banner sit OUTSIDE the
            blocked branch below, on purpose. `app-sharing` off refuses the
            share READ but never a revoke (`ADMIN_MAY_BYPASS_TOGGLE`), which
            is the API's own rule: an operator who switches the feature off
            during an incident must not thereby lose every lever for removing
            access. Hiding this whole section behind the toggle copy would
            reintroduce exactly that, and would swallow the confirmation of a
            revoke that had just succeeded. */}
        <div className="mt-4 space-y-1">
          {shareList.kind === 'loading' && (
            <p className="text-sm opacity-60">Loading shares and guests…</p>
          )}

          {shareList.kind === 'error' && (
            // NOT "nobody has been shared with" — the read failed, and the
            // grants it could not read are still live.
            <p className="text-sm text-amber-600 dark:text-amber-400">{shareList.message}</p>
          )}

          {shareList.kind === 'ok' && (
            <>
              {/* Scoped, and says so — the header explains why an unlabelled
                  list would be the wrong shape on this screen. */}
              {shareList.grants.length === 0 ? (
                <p className="text-sm opacity-60">
                  You haven&rsquo;t shared this app with an account yourself.
                </p>
              ) : (
                <>
                  <p className="text-xs uppercase tracking-wide opacity-50">Shared by you</p>
                  {shareList.grants.map(g => (
                    <AccountGrantRow
                      key={g.userId}
                      grant={g}
                      disabled={saving}
                      onRevoke={(userId, label) => void revokeGrant(userId, label)}
                    />
                  ))}
                </>
              )}

              {shareList.guests.length === 0 ? (
                <p className="pt-2 text-sm opacity-60">
                  You haven&rsquo;t invited anyone by email to this app yet.
                </p>
              ) : (
                <div className="space-y-1 pt-3">
                  <p className="text-xs uppercase tracking-wide opacity-50">Guests you invited</p>
                  {shareList.guests.map(g => (
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
            </>
          )}

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
          <InviteLinkPanel
            email={inviteLink.email}
            url={inviteLink.url}
            onResult={setShareBanner}
            onDismiss={() => setInviteLink(null)}
          />
        )}

        {/* Only the FORMS are replaced when a platform toggle refuses — and
            `app-sharing` takes BOTH of them, because every `/share` route is
            behind it. `guest-invites` takes only the email one. */}
        {inviteBlockedBy === 'sharing' ? (
          <p className="mt-4 border-t pt-4 text-sm opacity-70">
            Owner-initiated sharing is switched off for this platform, and both sharing and
            invitations go through the same route. Turning on “Let owners share their apps” under
            Settings → Platform re-enables them — that also lets every app owner share their own
            apps. Access can still be granted from the allow-list above.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
              <label className="text-sm">
                <span className="opacity-60">Username</span>
                <Input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="teammate"
                  disabled={saving || !view.enforceable}
                />
              </label>
              <Button
                onClick={handleGrant}
                disabled={saving || !view.enforceable || !username.trim()}
              >
                Share
              </Button>
            </div>

            <p className="mt-2 text-xs opacity-60">
              Sharing also ticks that person in the list above. Administrators and this app&rsquo;s
              owner cannot be shared with — they can open it already.
            </p>

            {inviteBlockedBy === 'guests' ? (
              <p className="mt-4 border-t pt-4 text-sm opacity-70">
                Guest invitations are switched off for this platform. Turn on “Let owners invite
                guests by email” under Settings → Platform.
              </p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="text-sm">
                    <span className="opacity-60">Or invite by email</span>
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
                  Re-entering an address that has already been invited sends a fresh invitation —
                  that is the only way to replace a lost or expired one, because the link is never
                  stored.
                </p>
              </>
            )}

            {!view.enforceable && (
              <p className="mt-2 text-xs opacity-60">
                Sharing and invitations are unavailable while this platform cannot enforce a gate
                here.
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
