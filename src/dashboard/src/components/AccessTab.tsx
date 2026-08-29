import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, ShieldOff, Users } from 'lucide-react';
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
 */

interface AccessView {
  access: { mode: string; allow: string[] } | null;
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

  const load = useCallback(async () => {
    const res = await apiJsonWithStatus<AccessView>(`/apps/${appName}/access`);
    setStatus(res.status);
    if (res.success && res.data) {
      setView(res.data);
      // The allow-list is the SOURCE; the checkboxes mirror it. Re-seeding on
      // every load means a failed save cannot leave the form claiming a state
      // the server never accepted.
      // asArray, not `?? []`: `new Set` throws on a non-iterable, and a `{}`
      // there is neither null nor undefined so the default never fires
      // (DROP-237).
      setSelected(new Set(asArray<string>(res.data.access?.allow)));
      setReviewBy(res.data.reviewBy ? res.data.reviewBy.slice(0, 10) : '');
    }
  }, [appName]);

  useEffect(() => {
    void load();
  }, [load]);

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
    const res = await apiJsonWithStatus(`/apps/${appName}/access`, { method: 'DELETE' });
    setSaving(false);
    setBanner(
      res.success
        ? { kind: 'ok', text: 'Access gate removed.' }
        : { kind: 'error', text: res.error?.message || 'Could not remove the gate.' }
    );
    await load();
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
          The owner and administrators can always open this app. Everyone else must be listed here.
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
