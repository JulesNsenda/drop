import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Table2, AlertTriangle } from 'lucide-react';
import { apiJson } from '../api/client';
import Card from './ui/Card';
import StatCard from './ui/StatCard';
import Button from './ui/Button';
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

/**
 * Database tab (DROP-120 M1): read-only overview + table list for an app's
 * provisioned database. On-demand refresh only — no polling, no
 * `setInterval` — the backing store is a shared PostgreSQL instance, and a
 * polled tab would add SCRAM-handshake load against it on every open dashboard.
 */
function DatabaseTab({ name }: { name: string }) {
  const [overview, setOverview] = useState<DbOverview | null>(null);
  const [tables, setTables] = useState<DbTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tablesError, setTablesError] = useState('');

  const load = useCallback(
    async (isRefresh: boolean) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      setTablesError('');

      const overviewJson = await apiJson<DbOverview>(`/db/${encodeURIComponent(name)}`);
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
      <Card className="py-12 text-center">
        <Database className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--text-3)' }} />
        <h3 className="mb-1 text-base font-semibold" style={{ color: 'var(--text)' }}>
          No database provisioned for this app
        </h3>
        <p className="mx-auto max-w-md text-sm" style={{ color: 'var(--text-2)' }}>
          DROP provisions one automatically when an app declares <code>database: postgres</code>{' '}
          in its <code>drop.yaml</code>, or ships a Postgres client in <code>package.json</code>.
        </p>
      </Card>
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
