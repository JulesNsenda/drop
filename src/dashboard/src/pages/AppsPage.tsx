import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Clock,
  Cpu,
  ExternalLink,
  Filter,
  GitBranch,
  Layers,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import { useApps } from '../hooks/useApi';
import type { App } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { appLinkInfo } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import Badge, { statusToTone } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import StatCard from '../components/ui/StatCard';

const STATUS_OPTIONS = ['all', 'running', 'stopped', 'building', 'errored', 'pending'] as const;

const DOT_COLOR: Record<string, string> = {
  ok: 'var(--ok)',
  err: 'var(--err)',
  warn: 'var(--warn)',
  accent: 'var(--accent)',
  neutral: 'var(--text-3)',
};

/**
 * The `/apps` list endpoint joins in live runtime stats (memory/cpu, and now
 * uptime — PRD-048) for running apps (see `src/api/routes/apps.ts`); the
 * shared `App` type (hooks/useApi.ts) already declares these as optional.
 * Kept as a local alias for narrower typing at the two call sites below.
 */
type AppWithStats = App & { cpu?: number; memory?: number };

function formatDate(dateString?: string) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  return date.toLocaleString();
}

/** A single app row, shared by the flat (ungrouped) list and grouped sections. */
function AppListCard({ app, isAdmin }: { app: App; isAdmin: boolean }) {
  return (
    <Link to={`/apps/${app.name}`} className="block">
      <Card className="transition-colors hover:!border-[var(--accent-2)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ background: DOT_COLOR[statusToTone(app.status)] }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate font-semibold" style={{ color: 'var(--text)' }}>
                  {app.name}
                </h3>
                <StatusBadge status={app.status} />
              </div>
              <p className="truncate text-sm" style={{ color: 'var(--text-3)' }}>
                {app.type}
                {app.framework && ` · ${app.framework}`}
                {app.port ? ` · :${app.port}` : ''}
              </p>
            </div>
          </div>

          <div
            className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm sm:justify-end"
            style={{ color: 'var(--text-2)' }}
          >
            {app.port && app.status === 'running' && (
              <a
                href={appLinkInfo(app).href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 hover:underline"
                style={{ color: 'var(--accent)' }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>{appLinkInfo(app).label}</span>
              </a>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" style={{ color: 'var(--text-3)' }} />
              {formatDate(app.lastDeployedAt)}
            </span>
            {isAdmin && app.ownerName && (
              <span className="inline-flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" style={{ color: 'var(--text-3)' }} />
                {app.ownerName}
              </span>
            )}
          </div>
        </div>

        {app.error && (
          <div
            className="mt-3 truncate rounded-lg px-3 py-2 text-xs"
            style={{
              background: 'color-mix(in srgb, var(--err) 15%, transparent)',
              color: 'var(--err)',
            }}
          >
            {app.error}
          </div>
        )}
      </Card>
    </Link>
  );
}

function AppsPage() {
  const { apps, loading, error, refresh } = useApps();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Spinner feedback for a CLICK, not for the 5s background poll. Sourcing it
  // from the hook's in-flight state instead would leave the button dead — and
  // twitching — for a slice of every interval on a page nobody is touching.
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const handleRefresh = async () => {
    setManualRefreshing(true);
    try {
      await refresh();
    } finally {
      setManualRefreshing(false);
    }
  };

  const filteredApps = useMemo(() => {
    return apps.filter(app => {
      const matchesSearch =
        !search ||
        app.name.toLowerCase().includes(search.toLowerCase()) ||
        app.type.toLowerCase().includes(search.toLowerCase()) ||
        (app.framework && app.framework.toLowerCase().includes(search.toLowerCase()));

      const matchesStatus = statusFilter === 'all' || app.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [apps, search, statusFilter]);

  // Monorepo grouping (purely presentational, on top of filteredApps): apps
  // that share a non-empty `group` (e.g. multiple services from the same repo
  // root) are clustered under a labeled section; apps with no group render as
  // a plain flat list, same as before grouping existed.
  const { groupedSections, ungroupedApps } = useMemo(() => {
    const sections: { group: string; apps: App[] }[] = [];
    const sectionIndexByGroup = new Map<string, number>();
    const ungrouped: App[] = [];

    for (const app of filteredApps) {
      if (app.group) {
        let idx = sectionIndexByGroup.get(app.group);
        if (idx === undefined) {
          idx = sections.length;
          sectionIndexByGroup.set(app.group, idx);
          sections.push({ group: app.group, apps: [] });
        }
        sections[idx].apps.push(app);
      } else {
        ungrouped.push(app);
      }
    }

    return { groupedSections: sections, ungroupedApps: ungrouped };
  }, [filteredApps]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    for (const app of apps) {
      counts[app.status] = (counts[app.status] || 0) + 1;
    }
    return counts;
  }, [apps]);

  // Overview strip (PRD-047 §2.3) — real data only. "Apps online" is a count
  // from the apps list already fetched. "Avg CPU" only renders when at least
  // one running app actually carries a `cpu` sample; there is no
  // "Databases"/"Requests per min" data source on this endpoint, so those
  // cards are omitted rather than fabricated (PRD-048 territory).
  const runningCount = useMemo(() => apps.filter(app => app.status === 'running').length, [apps]);

  const avgCpu = useMemo(() => {
    const samples = (apps as AppWithStats[])
      .filter(app => app.status === 'running' && typeof app.cpu === 'number')
      .map(app => app.cpu as number);
    if (samples.length === 0) return null;
    return samples.reduce((sum, v) => sum + v, 0) / samples.length;
  }, [apps]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
            Applications
          </h1>
          <p style={{ color: 'var(--text-2)' }}>
            {apps.length} app{apps.length !== 1 ? 's' : ''} deployed
          </p>
        </div>
        <Button variant="secondary" onClick={handleRefresh} disabled={manualRefreshing}>
          <RefreshCw className={`h-4 w-4 ${manualRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Overview stat strip */}
      {apps.length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Apps online" value={`${runningCount}/${apps.length}`} icon={GitBranch} />
          {avgCpu !== null && (
            <StatCard label="Avg CPU" value={`${avgCpu.toFixed(1)}%`} icon={Cpu} />
          )}
        </div>
      )}

      {/* Search and filter bar */}
      {apps.length > 0 && (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          {/* Search */}
          <div className="relative max-w-md flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
              style={{ color: 'var(--text-3)' }}
            />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="dui-input w-full rounded-lg py-2 pl-10 pr-3 text-sm outline-none"
            />
          </div>

          {/* Status filter */}
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="h-4 w-4" style={{ color: 'var(--text-3)' }} />
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                  style={
                    statusFilter === s
                      ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                      : { background: 'var(--bg-2)', color: 'var(--text-2)' }
                  }
                >
                  {s === 'all'
                    ? `All (${statusCounts.all || 0})`
                    : `${s} (${statusCounts[s] || 0})`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="mb-6 rounded-lg border px-4 py-3 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--err) 15%, transparent)',
            borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
            color: 'var(--err)',
          }}
        >
          {error}
        </div>
      )}

      {/* First load only. Without this the body was empty until the first
          response arrived — every block below is gated on either `!loading` or
          `apps.length > 0`, so there was nothing at all to render at t=0. */}
      {loading && (
        <div className="flex animate-pulse flex-col gap-3" aria-hidden="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-20 rounded-xl" style={{ background: 'var(--bg-2)' }} />
          ))}
        </div>
      )}

      {/* Empty state - onboarding. Gated on `!error` too: a failed first load
          leaves `apps` empty without ever having loaded, and telling someone
          whose API is down to "deploy your first app" is a lie — that is
          exactly the population reporting this page. */}
      {!loading && !error && apps.length === 0 && (
        <Card className="mx-auto max-w-lg p-10 text-center">
          <div
            className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{ background: 'var(--accent-soft)' }}
          >
            <GitBranch className="h-8 w-8" style={{ color: 'var(--accent)' }} />
          </div>
          <h2 className="mb-2 text-xl font-bold" style={{ color: 'var(--text)' }}>
            Deploy your first app
          </h2>
          <p className="mb-8 leading-relaxed" style={{ color: 'var(--text-2)' }}>
            Paste a GitHub repo URL and your app will be live in seconds. Supports Node.js, Python,
            Go, static sites, and Docker.
          </p>
          <Button variant="primary" onClick={() => navigate('/deploy')}>
            Deploy from GitHub
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Card>
      )}

      {/* No results from filter */}
      {apps.length > 0 && filteredApps.length === 0 && (
        <EmptyState
          icon={Search}
          title="No apps match your search"
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setStatusFilter('all');
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}

      {/* Apps list */}
      {filteredApps.length > 0 && (
        <div className="flex flex-col gap-6">
          {/* Monorepo groups — sibling apps deployed from the same repo root */}
          {groupedSections.map(section => (
            <div key={section.group}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Layers className="h-4 w-4" style={{ color: 'var(--text-3)' }} />
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                  {section.group}
                  <span className="font-normal" style={{ color: 'var(--text-3)' }}>
                    {' '}
                    · {section.apps.length} service{section.apps.length !== 1 ? 's' : ''}
                  </span>
                </h2>
                <Badge tone="neutral">monorepo</Badge>
              </div>
              <div
                className="flex flex-col gap-3 border-l-2 pl-4"
                style={{ borderColor: 'var(--border)' }}
              >
                {section.apps.map(app => (
                  <AppListCard key={app.name} app={app} isAdmin={isAdmin} />
                ))}
              </div>
            </div>
          ))}

          {/* Ungrouped apps render as a plain flat list, same as before grouping existed */}
          {ungroupedApps.length > 0 && (
            <div className="flex flex-col gap-3">
              {ungroupedApps.map(app => (
                <AppListCard key={app.name} app={app} isAdmin={isAdmin} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AppsPage;
