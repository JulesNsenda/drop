import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Table2, AlertTriangle, Server, Plug } from 'lucide-react';
import { apiJson, apiJsonWithStatus } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import Card from './ui/Card';
import StatCard from './ui/StatCard';
import Button from './ui/Button';
import Badge from './ui/Badge';
// Types and the row-estimate heuristic live in a plain .ts sibling so the root
// jest can cover them — this package has no test runner of its own, and that
// heuristic decides what number an operator actually reads. See db-format.ts.
import {
  formatBytes,
  formatRowEstimate,
  isUntrustedZero,
  type DbOverview,
  type DbTable,
} from './db-format';
// Attach decision logic (DROP-151 Phase 2) — same "no test runner" reason as
// db-format.ts above; see attach-state.ts's header for why this .tsx should
// stay as dumb as possible about what the Attach controls decide.
import {
  describeAttachCard,
  describeAttachRefusal,
  formatQuotaUsage,
  type QuotaState,
  type ServiceId,
  type ServiceIntent,
} from './attach-state';

/**
 * `GET /db/:name`'s full response shape (DROP-151 Phase 2) — extends the
 * DROP-120 `DbOverview` with what the Attach UI needs: whether Redis is
 * provisioned, the owner's persisted attach/detach intent per service, and
 * per-app quota state. Declared here (not in db-format.ts) so that file stays
 * scoped to the read-only panel it was built for; kept in sync by hand with
 * `src/api/routes/db.ts`.
 */
interface DbOverviewResponse extends DbOverview {
  redis: { provisioned: boolean };
  services: Partial<Record<ServiceId, ServiceIntent>>;
  quota: { postgres: QuotaState; redis: QuotaState };
}

/** Used only when `overview` hasn't loaded yet (or a service is genuinely
 * absent from `quota`) — an unconstrained quota never disables the control. */
const NO_QUOTA: QuotaState = { used: 0, limit: 0, constrained: false };

const SERVICE_LABEL: Record<ServiceId, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
};

const SERVICE_ICON: Record<ServiceId, typeof Database> = {
  postgres: Database,
  redis: Server,
};

interface ServiceRowProps {
  id: ServiceId;
  provisioned: boolean;
  intent: ServiceIntent | undefined;
  quota: QuotaState;
  role: 'admin' | 'user' | 'readonly' | undefined;
  attaching: boolean;
  /** A DIFFERENT service is currently attaching. Disables this row's button
   * too — `handleAttach`'s single in-flight guard already refuses a second
   * click functionally, but leaving the other button visually enabled would
   * invite one that silently does nothing. */
  blockedByOtherAttach: boolean;
  refusal: { message: string; quota?: { used: number; limit: number } } | undefined;
  onAttach: (id: ServiceId) => void;
}

/**
 * One backing service's row in the Attach section. All the deciding —
 * whether the control renders, is enabled, and what it says — happens in
 * `describeAttachCard`; this stays a straight render of its output plus the
 * server's own refusal text, so the honesty rules in attach-state.ts have
 * exactly one place they can be gotten wrong.
 */
function ServiceRow({
  id,
  provisioned,
  intent,
  quota,
  role,
  attaching,
  blockedByOtherAttach,
  refusal,
  onAttach,
}: ServiceRowProps) {
  const view = describeAttachCard({ provisioned, intent, quota, role });
  const Icon = SERVICE_ICON[id];
  const label = SERVICE_LABEL[id];

  return (
    <div
      className="flex flex-col gap-2 border-b py-3 last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" style={{ color: 'var(--text-2)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>
            {label}
          </span>
        </div>

        {view.attached ? (
          <Badge tone="ok">Attached</Badge>
        ) : role === 'readonly' ? (
          // The API gates POST at `user` — a readonly viewer must not see a
          // button that would 403. Omitted outright, not rendered disabled:
          // matches AppDetailPage.tsx:130's `canManageCredential`, which
          // hides its git-credential control the same way rather than
          // showing a dead one with an explanation.
          <Badge tone="neutral">Not attached</Badge>
        ) : (
          <div className="flex items-center gap-3">
            {quota.constrained && (
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                {formatQuotaUsage(quota)}
              </span>
            )}
            <Button
              variant="secondary"
              loading={attaching}
              // `!view.canAttach` is defense-in-depth, not the primary gate
              // for readonly (the branch above never lets this Button render
              // for that case at all). `blockedByOtherAttach` is the primary
              // gate for the in-flight guard: it keeps this row's control
              // from inviting a click that `handleAttach` would silently
              // no-op while the other service's attach (and its confirm
              // dialog) is in flight.
              disabled={!view.canAttach || blockedByOtherAttach}
              onClick={() => onAttach(id)}
            >
              <Plug className="h-4 w-4" />
              {view.actionLabel}
            </Button>
          </div>
        )}
      </div>

      {!view.attached && role !== 'readonly' && view.disabledReason === 'quota-exceeded' && (
        <p className="text-xs" style={{ color: 'var(--warn)' }}>
          {label} quota reached — free up a service before attaching another.
        </p>
      )}
      {!view.attached && role !== 'readonly' && !view.disabledReason && view.previouslyDetached && (
        <p className="text-xs" style={{ color: 'var(--text-3)' }}>
          Previously detached — attaching will re-provision it.
        </p>
      )}

      {refusal && (
        <div
          role="alert"
          className="rounded-lg p-2 text-xs"
          style={{
            background: 'color-mix(in srgb, var(--err) 10%, transparent)',
            color: 'var(--err)',
          }}
        >
          {refusal.message}
          {refusal.quota && (
            <span className="mt-1 block" style={{ color: 'var(--text-3)' }}>
              {formatQuotaUsage(refusal.quota)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Database tab (DROP-120 M1): read-only overview + table list for an app's
 * provisioned database. On-demand refresh only — no polling, no
 * `setInterval` — the backing store is a shared PostgreSQL instance, and a
 * polled tab would add SCRAM-handshake load against it on every open dashboard.
 *
 * DROP-151 Phase 2 adds the Attach controls (Backing services, below): both
 * services live in this same tab rather than a new one — DROP-120 already
 * made `provisioned: false` first-class content here, and a second panel
 * would give two accounts of one database.
 */
function DatabaseTab({ name }: { name: string }) {
  const [overview, setOverview] = useState<DbOverviewResponse | null>(null);
  const [tables, setTables] = useState<DbTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tablesError, setTablesError] = useState('');

  const { role } = useAuth();
  const { toast } = useToast();
  const confirmDialog = useConfirm();

  // Component-owned — `usePolledJson` deliberately carries no in-flight flag
  // (hooks/useApi.ts), and this tab doesn't even poll. Attach provisions a
  // resource AND restarts the app, which can take up to the readiness
  // timeout (60s default), so the button needs its own loading state for
  // that whole span, not just the network round trip.
  const [attachingService, setAttachingService] = useState<ServiceId | null>(null);
  const [attachRefusals, setAttachRefusals] = useState<
    Partial<Record<ServiceId, { message: string; quota?: { used: number; limit: number } }>>
  >({});

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setTablesError('');
      // A refusal banner is a snapshot of the moment it happened (e.g. a
      // quota-exceeded reading) — it goes stale the instant fresher data
      // arrives, whether from this same Refresh, a successful attach's own
      // refresh, or (since this component has no route `key` and React
      // reuses the instance across app navigation, same trap as
      // `credentialChoice` at AppDetailPage.tsx:141-149) a switch to a
      // different app. Clearing per-service state here, not just at the
      // start of the next attach attempt, is what stops a fixed quota still
      // reading "reached" next to a badge that now shows headroom.
      setAttachRefusals({});

      const overviewJson = await apiJson<DbOverviewResponse>(`/db/${encodeURIComponent(name)}`);
      if (!overviewJson.success || !overviewJson.data) {
        setError(overviewJson.error?.message || 'Failed to load database overview');
        setOverview(null);
        setTables([]);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      setOverview(overviewJson.data);
      // Clear a stale error from an earlier failed load — without this, a
      // transient failure (e.g. a gate rejection from a concurrent request,
      // React StrictMode's double-invoked mount effect being the common
      // trigger in dev) latches the red error card forever, since nothing
      // else ever clears it once this component has a successful overview.
      setError('');

      // provisioned:false is a first-class, non-error state — no need to hit
      // /tables for a database that doesn't exist.
      if (!overviewJson.data.provisioned) {
        setTables([]);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const tablesJson = await apiJson<{ tables: DbTable[] }>(`/db/${encodeURIComponent(name)}/tables`);
      if (tablesJson.success && tablesJson.data) {
        setTables(tablesJson.data.tables);
        setTablesError('');
      } else {
        setTablesError(tablesJson.error?.message || 'Failed to load tables');
        setTables([]);
      }

      setLoading(false);
      setRefreshing(false);
    },
    [name]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const handleAttach = useCallback(
    async (serviceId: ServiceId) => {
      // Single in-flight guard — ConfirmProvider (ConfirmDialog.tsx) holds
      // exactly one pending `resolve`, so a second confirm() before this one
      // settles overwrites the first, whose `await` then never resolves at
      // all. Mirrors DeployPage.tsx's uploadFiles guard, but armed BEFORE
      // confirmDialog — not after, like that precedent could get away with
      // for a single upload flow. The dialog itself awaits a user click, so
      // arming only after it resolves leaves the guard disarmed for the
      // dialog's entire lifetime: the OTHER service's button is still
      // enabled behind the modal, and a click (or Tab+Enter — the dialog
      // traps no focus) opens a second confirm() and strands the first.
      if (attachingService) return;
      setAttachingService(serviceId);

      const label = SERVICE_LABEL[serviceId];
      const confirmed = await confirmDialog({
        title: `Attach ${label}`,
        message:
          `DROP will provision ${label} for "${name}" and restart the app to inject the ` +
          'connection details. Attaching can take up to a minute, and the app will be ' +
          'unavailable while it restarts. This can\'t be undone from the dashboard.',
        confirmText: 'Attach',
        variant: 'danger',
      });
      if (!confirmed) {
        setAttachingService(null);
        return;
      }

      setAttachRefusals(prev => ({ ...prev, [serviceId]: undefined }));

      const result = await apiJsonWithStatus<{ message: string; envVarNames: string[] }>(
        `/apps/${encodeURIComponent(name)}/services/${serviceId}`,
        { method: 'POST' }
      );

      if (result.success) {
        toast('success', `${label} attached to ${name}`);
        setAttachingService(null);
        // On-demand refresh, matching the Refresh button — this tab is
        // deliberately non-polling (see the header comment), so a successful
        // attach is the one place besides a manual click that must re-fetch.
        await load(true);
        return;
      }

      const details = result.error?.details as
        | { reason?: string; quota?: { used: number; limit: number } }
        | undefined;
      setAttachRefusals(prev => ({
        ...prev,
        [serviceId]: {
          message: describeAttachRefusal(details?.reason, result.error?.message),
          quota: details?.reason === 'quota-exceeded' ? details.quota : undefined,
        },
      }));
      setAttachingService(null);
    },
    [attachingService, confirmDialog, name, toast, load]
  );

  const servicesCard = (
    <Card padded={false}>
      <div
        className="flex items-center border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <Plug className="mr-2 h-4 w-4" style={{ color: 'var(--text-2)' }} />
        <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
          Backing services
        </h2>
      </div>
      <div className="px-4">
        <ServiceRow
          id="postgres"
          provisioned={overview?.provisioned ?? false}
          intent={overview?.services?.postgres}
          quota={overview?.quota?.postgres ?? NO_QUOTA}
          role={role}
          attaching={attachingService === 'postgres'}
          blockedByOtherAttach={attachingService !== null && attachingService !== 'postgres'}
          refusal={attachRefusals.postgres}
          onAttach={handleAttach}
        />
        <ServiceRow
          id="redis"
          provisioned={overview?.redis?.provisioned ?? false}
          intent={overview?.services?.redis}
          quota={overview?.quota?.redis ?? NO_QUOTA}
          role={role}
          attaching={attachingService === 'redis'}
          blockedByOtherAttach={attachingService !== null && attachingService !== 'redis'}
          refusal={attachRefusals.redis}
          onAttach={handleAttach}
        />
      </div>
    </Card>
  );

  if (loading) {
    return (
      <Card className="animate-pulse space-y-3">
        <div className="h-4 w-40 rounded" style={{ background: 'var(--bg-2)' }} />
        <div className="h-20 rounded" style={{ background: 'var(--bg-2)' }} />
        <div className="h-32 rounded" style={{ background: 'var(--bg-2)' }} />
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-12 text-center">
        <AlertTriangle className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--err)' }} />
        <h3 className="mb-1 text-base font-semibold" style={{ color: 'var(--text)' }}>
          Couldn&apos;t load the database panel
        </h3>
        <p className="mb-4 text-sm" style={{ color: 'var(--text-2)' }}>
          {error}
        </p>
        <Button variant="secondary" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Retry
        </Button>
      </Card>
    );
  }

  if (!overview || !overview.provisioned) {
    return (
      <div className="space-y-4">
        <Card className="py-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--text-3)' }} />
          <h3 className="mb-1 text-base font-semibold" style={{ color: 'var(--text)' }}>
            No database provisioned for this app
          </h3>
          <p className="mx-auto max-w-md text-sm" style={{ color: 'var(--text-2)' }}>
            DROP provisions one automatically when an app declares <code>database: postgres</code>{' '}
            in its <code>drop.yaml</code>, or ships a Postgres client in <code>package.json</code>
            — or attach one directly below.
          </p>
        </Card>
        {servicesCard}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="secondary" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {servicesCard}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Database" value={overview.database || '—'} icon={Database} />
        <StatCard
          label="Size"
          value={typeof overview.sizeBytes === 'number' ? formatBytes(overview.sizeBytes) : '—'}
        />
        <StatCard
          label="Tables"
          value={typeof overview.tableCount === 'number' ? overview.tableCount : '—'}
          icon={Table2}
        />
      </div>

      <Card padded={false}>
        <div
          className="flex items-center border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <Table2 className="mr-2 h-4 w-4" style={{ color: 'var(--text-2)' }} />
          <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
            Tables
          </h2>
        </div>
        <div className="p-4">
          {tablesError ? (
            <p className="text-sm" style={{ color: 'var(--err)' }}>
              {tablesError}
            </p>
          ) : tables.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              No tables yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <th
                      className="text-left py-2 pr-4 font-medium"
                      style={{ color: 'var(--text-3)' }}
                    >
                      Name
                    </th>
                    <th
                      className="text-left py-2 pr-4 font-medium"
                      style={{ color: 'var(--text-3)' }}
                    >
                      Row estimate
                    </th>
                    <th className="text-left py-2 font-medium" style={{ color: 'var(--text-3)' }}>
                      Size
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map(t => (
                    <tr
                      key={t.name}
                      className="border-b last:border-b-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <td
                        className="py-2.5 pr-4 font-mono font-medium"
                        style={{ color: 'var(--text)' }}
                      >
                        {t.name}
                      </td>
                      <td
                        className="py-2.5 pr-4"
                        style={{ color: isUntrustedZero(t) ? 'var(--text-3)' : 'var(--text)' }}
                      >
                        {formatRowEstimate(t)}
                      </td>
                      <td className="py-2.5" style={{ color: 'var(--text-2)' }}>
                        {formatBytes(t.sizeBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default DatabaseTab;
