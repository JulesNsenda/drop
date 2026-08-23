import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, ShieldCheck, ShieldOff, Users } from 'lucide-react';
import { apiJsonWithStatus } from '../api/client';
import Card from './ui/Card';

/**
 * The governance estate view for one app (DROP-152 AC3).
 *
 * The reason this exists rather than a simple "gated / not gated" badge: a
 * policy being STORED and a policy being ENFORCED are different facts, and the
 * gap between them is exactly what an operator needs to see. Three separate
 * signals, none of which implies another:
 *
 *   enforceable — could this BOX enforce a gate at all?
 *   enforced    — is this build's gate actually in front of traffic?
 *   gateApplied — did the platform's last route emission reach Caddy?
 *
 * A box can be capable, the build can have the emitter, and the emission can
 * still have failed — which is the state that would otherwise show as
 * "protected" while every request walked straight through.
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

function AccessTab({ appName }: { appName: string }) {
  const [view, setView] = useState<AccessView | null>(null);
  const [status, setStatus] = useState<number>(0);

  useEffect(() => {
    void (async () => {
      const res = await apiJsonWithStatus<AccessView>(`/apps/${appName}/access`);
      setStatus(res.status);
      if (res.success && res.data) setView(res.data);
    })();
  }, [appName]);

  // Admin-only, because the visitor set is personal data about third parties.
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
  // The disagreement worth shouting about: a policy exists, the box can carry
  // it, and the platform says the guard is not actually in Caddy.
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

      {gated && (
        <Card className="p-6">
          <h3 className="flex items-center gap-2 font-semibold">
            <Lock className="h-4 w-4" /> Who may open it
          </h3>
          {view.access!.allow.length === 0 ? (
            <p className="mt-2 text-sm opacity-70">
              The owner and administrators only — the allow-list is empty.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {view.access!.allow.map(id => (
                <li key={id} className="font-mono text-xs opacity-80">
                  {id}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h3 className="flex items-center gap-2 font-semibold">
          <Users className="h-4 w-4" /> Who has opened it
        </h3>
        {view.recentOpeners.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">
            {/* "Nobody recently" and "nobody ever" are the same answer here —
                the summary is kept in app state precisely so it is not lost to
                log retention, but an app that predates the gate has none. */}
            No recorded sign-ins.
          </p>
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
