import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Table2, AlertTriangle, Server, Plug, Unplug } from 'lucide-react';
import { apiJson, apiJsonWithStatus } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from './ui/Table';
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
  describeDetachConfirm,
  describeDetachOutcome,
  describeDetachRefusal,
  formatQuotaUsage,
  isControlBlocked,
  recordServiceRefusal,
  type DetachServiceSuccess,
  type PendingServiceAction,
  type QuotaState,
  type ServiceId,
  type ServiceIntent,
  type ServiceRefusals,
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
  /** Whether this app is ephemeral — the Detach confirm
   * dialog needs this so it never promises a Postgres backup an ephemeral
   * app's detach doesn't actually write. */
  ephemeral: boolean;
  /** Set instead of a 503 when the database named in this app's stored
   * credentials no longer exists — a renderable, repairable
   * state, not a dead end. See the `!overview.provisioned` branch below. */
  broken?: 'database-missing';
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
  /** Postgres only — `overview.broken`. Absent for redis, which has
   * no equivalent stale-registry-entry state on the wire. */
  broken?: 'database-missing';
  intent: ServiceIntent | undefined;
  quota: QuotaState;
  role: 'admin' | 'user' | 'readonly' | undefined;
  /** DatabaseTab.tsx's single in-flight slot, or null when nothing is
   * pending. `attaching`/`detaching`/`attachBlocked`/`detachBlocked` are all
   * derived from this plus `id` below via `isControlBlocked` — handing down
   * four separate booleans the parent had to keep in sync by hand (two of
   * them longhand complements of `isControlBlocked` itself) let them drift
   * from the helper that actually owns the relationship. */
  pending: PendingServiceAction | null;
  refusal: { message: string; quota?: { used: number; limit: number } } | undefined;
  onAttach: (id: ServiceId) => void;
  onDetach: (id: ServiceId) => void;
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
  broken,
  intent,
  quota,
  role,
  pending,
  refusal,
  onAttach,
  onDetach,
}: ServiceRowProps) {
  const view = describeAttachCard({ provisioned, broken, intent, quota, role });
  const Icon = SERVICE_ICON[id];
  const label = SERVICE_LABEL[id];
  const attaching = pending?.service === id && pending.kind === 'attach';
  const detaching = pending?.service === id && pending.kind === 'detach';
  // A DIFFERENT action (any other service's, OR this same service's OTHER
  // control) currently has an attach or detach in flight — see
  // `isControlBlocked`'s doc. The single `pendingAction` in-flight guard in
  // `handleAttach`/`handleDetach` already refuses a second click
  // functionally, but leaving a control visually enabled would invite one
  // that silently does nothing. Split per-button: a pending attach on THIS
  // service must not leave THIS service's own Detach button enabled.
  const attachBlocked = isControlBlocked(pending, id, 'attach');
  const detachBlocked = isControlBlocked(pending, id, 'detach');

  return (
    <div
      className="flex flex-col gap-2 border-b py-3 last:border-b-0 border-line"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted" />
          <span className="text-sm font-medium text-fg">
            {label}
          </span>
        </div>

        {view.detachIncomplete || view.attached ? (
          // Still provisioned. `detachIncomplete` means the last recorded
          // intent is 'detached' — a prior detach persisted its intent
          // (persist-first, Phase 3) but didn't finish deprovisioning; never
          // render that as plain "Attached", that would hide the only repair
          // affordance. Otherwise this is a cleanly attached service. Only
          // the badge differs between the two — the Detach control itself is
          // identical either way.
          <div className="flex items-center gap-3">
            <Badge tone={view.detachIncomplete ? 'warn' : 'ok'}>
              {view.detachIncomplete ? 'Detach incomplete' : 'Attached'}
            </Badge>
            {view.canDetach && (
              <Button
                variant="danger"
                loading={detaching}
                disabled={detachBlocked}
                onClick={() => onDetach(id)}
              >
                <Unplug className="h-4 w-4" />
                {view.detachActionLabel}
              </Button>
            )}
          </div>
        ) : role === 'readonly' ? (
          // The API gates POST/DELETE at `user` — a readonly viewer must not
          // see a button that would 403. Omitted outright, not rendered
          // disabled: matches AppDetailPage.tsx:130's `canManageCredential`,
          // which hides its git-credential control the same way rather than
          // showing a dead one with an explanation.
          <Badge tone="neutral">Not attached</Badge>
        ) : (
          <div className="flex items-center gap-3">
            {quota.constrained && (
              <span className="text-xs text-faint">
                {formatQuotaUsage(quota)}
              </span>
            )}
            <Button
              variant="secondary"
              loading={attaching}
              // `!view.canAttach` is defense-in-depth, not the primary gate
              // for readonly (the branch above never lets this Button render
              // for that case at all). `attachBlocked` is the primary gate
              // for the in-flight guard: it keeps this control from inviting
              // a click that `handleAttach`/`handleDetach` would silently
              // no-op while another action (and its confirm dialog) is in
              // flight — including THIS service's own Detach (see
              // `isControlBlocked`'s doc).
              disabled={!view.canAttach || attachBlocked}
              onClick={() => onAttach(id)}
            >
              <Plug className="h-4 w-4" />
              {view.actionLabel}
            </Button>
          </div>
        )}
      </div>

      {view.detachIncomplete && view.canDetach && (
        <p className="text-xs text-warn">
          A previous detach did not finish — retry to complete it.
        </p>
      )}
      {!view.attached && !view.detachIncomplete && role !== 'readonly' && view.disabledReason === 'quota-exceeded' && (
        <p className="text-xs text-warn">
          {label} quota reached — free up a service before attaching another.
        </p>
      )}
      {!view.attached && !view.detachIncomplete && role !== 'readonly' && !view.disabledReason && view.previouslyDetached && (
        <p className="text-xs text-faint">
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
            <span className="mt-1 block text-faint">
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

  // Whether this app is ephemeral (`overview.ephemeral`, DROP-151 Phase 2
  // payload) — read once here rather than inline in handleDetach so the
  // callback's dependency array can key off this boolean instead of the
  // whole `overview` object.
  const ephemeral = overview?.ephemeral === true;

  // Component-owned — `usePolledJson` deliberately carries no in-flight flag
  // (hooks/useApi.ts), and this tab doesn't even poll. Attach/detach each
  // provision-or-deprovision a resource AND restart the app, which can take
  // up to the readiness timeout (60s default), so the button needs its own
  // loading state for that whole span, not just the network round trip.
  //
  // One slot, not two booleans: `ConfirmProvider` (ConfirmDialog.tsx) holds
  // exactly one pending `resolve`, so an attach confirm and a detach confirm
  // can never be in flight at once regardless of which service or action
  // triggered them — a single `pendingAction` makes that constraint the
  // type, rather than two independently-settable flags that could disagree.
  const [pendingAction, setPendingAction] = useState<PendingServiceAction | null>(null);
  // One map, not two — see `recordServiceRefusal`'s doc (attach-state.ts)
  // for why a separate attach/detach pair let a stale attach banner survive
  // a later detach refusal on the same service.
  const [serviceRefusals, setServiceRefusals] = useState<ServiceRefusals>({});

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setTablesError('');
      // A refusal banner is a snapshot of the moment it happened (e.g. a
      // quota-exceeded reading) — it goes stale the instant fresher data
      // arrives, whether from this same Refresh, a successful attach/detach's
      // own refresh, or (since this component has no route `key` and React
      // reuses the instance across app navigation, same trap as
      // `credentialChoice` at AppDetailPage.tsx:141-149) a switch to a
      // different app. Clearing per-service state here, not just at the
      // start of the next attempt, is what stops a fixed quota still reading
      // "reached" next to a badge that now shows headroom.
      setServiceRefusals({});

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
      // dialog's entire lifetime: another button (this service's Detach, or
      // any other row's control) is still enabled behind the modal, and a
      // click (or Tab+Enter — the dialog traps no focus) opens a second
      // confirm() and strands the first.
      if (pendingAction) return;
      setPendingAction({ service: serviceId, kind: 'attach' });

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
        setPendingAction(null);
        return;
      }

      setServiceRefusals(prev => recordServiceRefusal(prev, serviceId, undefined));

      const result = await apiJsonWithStatus<{ message: string; envVarNames: string[] }>(
        `/apps/${encodeURIComponent(name)}/services/${serviceId}`,
        { method: 'POST' }
      );

      if (result.success) {
        toast('success', `${label} attached to ${name}`);
        setPendingAction(null);
        // On-demand refresh, matching the Refresh button — this tab is
        // deliberately non-polling (see the header comment), so a successful
        // attach is the one place besides a manual click that must re-fetch.
        await load(true);
        return;
      }

      const details = result.error?.details as
        | { reason?: string; quota?: { used: number; limit: number } }
        | undefined;
      setServiceRefusals(prev =>
        recordServiceRefusal(prev, serviceId, {
          message: describeAttachRefusal(details?.reason, result.error?.message),
          quota: details?.reason === 'quota-exceeded' ? details.quota : undefined,
        })
      );
      setPendingAction(null);
    },
    [pendingAction, confirmDialog, name, toast, load]
  );

  const handleDetach = useCallback(
    async (serviceId: ServiceId) => {
      // Same single in-flight guard as handleAttach — see its comment above.
      if (pendingAction) return;
      setPendingAction({ service: serviceId, kind: 'detach' });

      const label = SERVICE_LABEL[serviceId];
      // Per-service (and, for postgres, per-ephemeral) copy lives in
      // describeDetachConfirm — see its doc for why an ephemeral app's
      // postgres detach must not repeat the "a backup is written" promise.
      const detail = describeDetachConfirm(serviceId, ephemeral);
      const confirmed = await confirmDialog({
        title: `Detach ${label}`,
        message:
          `DROP will remove ${label} from "${name}" and restart the app so the connection ` +
          `details are no longer injected. ${detail} This can't be undone from the dashboard.`,
        confirmText: 'Detach',
        variant: 'danger',
      });
      if (!confirmed) {
        setPendingAction(null);
        return;
      }

      setServiceRefusals(prev => recordServiceRefusal(prev, serviceId, undefined));

      const result = await apiJsonWithStatus<DetachServiceSuccess>(
        `/apps/${encodeURIComponent(name)}/services/${serviceId}`,
        { method: 'DELETE' }
      );

      if (result.success) {
        // Mirrors handleAttach's `result.success`-only check — a detach that
        // succeeded but arrived without the expected `data` shape (a
        // contract mismatch, not a refusal) still gets a success toast, not
        // a red refusal banner over an operation that already happened.
        toast(
          'success',
          result.data ? describeDetachOutcome(label, result.data) : `${label} detached from "${name}".`
        );
        setPendingAction(null);
        // On-demand refresh, matching the Refresh button and handleAttach —
        // this tab is deliberately non-polling (see the header comment), so
        // a successful detach is the one place besides a manual click that
        // must re-fetch. It's also how a `detachIncomplete` retry gets to
        // see whether it actually converged.
        await load(true);
        return;
      }

      const details = result.error?.details as
        | { reason?: string; retryAfterSeconds?: number }
        | undefined;
      setServiceRefusals(prev =>
        recordServiceRefusal(prev, serviceId, {
          message: describeDetachRefusal(
            details?.reason,
            result.error?.message,
            details?.retryAfterSeconds
          ),
        })
      );
      setPendingAction(null);
    },
    [pendingAction, confirmDialog, name, toast, load, ephemeral]
  );

  const servicesCard = (
    <Card padded={false}>
      <div
        className="flex items-center border-b px-4 py-3 border-line"
      >
        <Plug className="mr-2 h-4 w-4 text-muted" />
        <h2 className="font-semibold text-fg">
          Backing services
        </h2>
      </div>
      <div className="px-4">
        <ServiceRow
          id="postgres"
          provisioned={overview?.provisioned ?? false}
          broken={overview?.broken}
          intent={overview?.services?.postgres}
          quota={overview?.quota?.postgres ?? NO_QUOTA}
          role={role}
          pending={pendingAction}
          refusal={serviceRefusals.postgres}
          onAttach={handleAttach}
          onDetach={handleDetach}
        />
        <ServiceRow
          id="redis"
          provisioned={overview?.redis?.provisioned ?? false}
          intent={overview?.services?.redis}
          quota={overview?.quota?.redis ?? NO_QUOTA}
          role={role}
          pending={pendingAction}
          refusal={serviceRefusals.redis}
          onAttach={handleAttach}
          onDetach={handleDetach}
        />
      </div>
    </Card>
  );

  if (loading) {
    return (
      <Card className="animate-pulse space-y-3">
        <div className="h-4 w-40 rounded bg-surface-2" />
        <div className="h-20 rounded bg-surface-2" />
        <div className="h-32 rounded bg-surface-2" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card padded={false}>
        <EmptyState
          icon={AlertTriangle}
          tone="error"
          size="sm"
          titleAs="h3"
          title="Couldn&apos;t load the database panel"
          description={error}
          action={
            <Button variant="secondary" onClick={() => load(true)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (!overview || !overview.provisioned) {
    // `broken: 'database-missing'` is a distinct state
    // from ordinary "never provisioned": the database is gone, but this
    // app's credentials — and possibly its role — are still on record. The
    // generic copy below would wrongly read as "nothing was ever here", so
    // this gets its own honest line instead; the repair
    // affordance is the Attach/Detach row already rendered in `servicesCard`.
    const missingDatabase = overview?.broken === 'database-missing';
    return (
      <div className="space-y-4">
        <Card className="py-12 text-center">
          <Database className="mx-auto mb-3 h-8 w-8 text-faint" />
          <h3 className="mb-1 text-base font-semibold text-fg">
            {missingDatabase ? 'Database missing' : 'No database provisioned for this app'}
          </h3>
          <p className="mx-auto max-w-md text-sm text-muted">
            {missingDatabase ? (
              <>
                The database named in this app&apos;s stored credentials no longer exists, though
                its credentials — and possibly its role — are still on record. Use Detach below to
                clear the stale record, or Attach to provision a fresh one.
              </>
            ) : (
              <>
                DROP provisions one automatically when an app declares <code>database: postgres</code>{' '}
                in its <code>drop.yaml</code>, or ships a Postgres client in <code>package.json</code>
                — or attach one directly below.
              </>
            )}
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
          className="flex items-center border-b px-4 py-3 border-line"
        >
          <Table2 className="mr-2 h-4 w-4 text-muted" />
          <h2 className="font-semibold text-fg">
            Tables
          </h2>
        </div>
        <div className="p-4">
          {tablesError ? (
            <p className="text-sm text-err">
              {tablesError}
            </p>
          ) : tables.length === 0 ? (
            <p className="text-sm text-muted">
              No tables yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table density="compact">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Row estimate</TableHeaderCell>
                    <TableHeaderCell className="pr-0">Size</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tables.map(t => (
                    <TableRow key={t.name} className="last:border-b-0">
                      <TableCell className="font-mono font-medium text-fg">{t.name}</TableCell>
                      <TableCell className={isUntrustedZero(t) ? 'text-faint' : 'text-fg'}>
                        {formatRowEstimate(t)}
                      </TableCell>
                      <TableCell className="pr-0 text-muted">{formatBytes(t.sizeBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default DatabaseTab;
