import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, ExternalLink, Clock, Search, Filter, User, GitBranch, ArrowRight } from 'lucide-react';
import { useApps } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { appLinkInfo } from '../api/client';
import StatusBadge from '../components/StatusBadge';

const STATUS_OPTIONS = ['all', 'running', 'stopped', 'building', 'errored', 'pending'] as const;

function AppsPage() {
  const { apps, loading, error, refresh } = useApps();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const filteredApps = useMemo(() => {
    return apps.filter((app) => {
      const matchesSearch =
        !search ||
        app.name.toLowerCase().includes(search.toLowerCase()) ||
        app.type.toLowerCase().includes(search.toLowerCase()) ||
        (app.framework && app.framework.toLowerCase().includes(search.toLowerCase()));

      const matchesStatus = statusFilter === 'all' || app.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [apps, search, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: apps.length };
    for (const app of apps) {
      counts[app.status] = (counts[app.status] || 0) + 1;
    }
    return counts;
  }, [apps]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Applications</h1>
          <p className="text-gray-500 dark:text-gray-400">
            {apps.length} app{apps.length !== 1 ? 's' : ''} deployed
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Search and filter bar */}
      {apps.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none text-sm"
            />
          </div>

          {/* Status filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            <div className="flex gap-1">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                    statusFilter === s
                      ? 'bg-drop-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  {s === 'all' ? `All (${statusCounts.all || 0})` : `${s} (${statusCounts[s] || 0})`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Empty state - onboarding */}
      {!loading && apps.length === 0 && (
        <div className="max-w-lg mx-auto text-center py-16">
          <div className="w-16 h-16 bg-drop-100 dark:bg-drop-900/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <GitBranch className="w-8 h-8 text-drop-600 dark:text-drop-400" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Deploy your first app</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-8 leading-relaxed">
            Paste a GitHub repo URL and your app will be live in seconds. Supports Node.js, Python, Go, static sites, and Docker.
          </p>
          <button
            onClick={() => navigate('/deploy')}
            className="inline-flex items-center gap-2 px-6 py-3 bg-drop-600 text-white rounded-lg hover:bg-drop-700 font-medium transition-colors"
          >
            Deploy from GitHub
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* No results from filter */}
      {apps.length > 0 && filteredApps.length === 0 && (
        <div className="text-center py-12">
          <Search className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400">No apps match your search</p>
          <button
            onClick={() => { setSearch(''); setStatusFilter('all'); }}
            className="mt-2 text-sm text-drop-600 hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Apps grid */}
      {filteredApps.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredApps.map((app) => (
            <Link
              key={app.name}
              to={`/apps/${app.name}`}
              className="block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:shadow-md hover:border-drop-300 dark:hover:border-drop-600 transition-all"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-white">{app.name}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {app.type}
                    {app.framework && ` / ${app.framework}`}
                  </p>
                </div>
                <StatusBadge status={app.status} />
              </div>

              <div className="space-y-2 text-sm">
                {app.port && app.status === 'running' && (
                  <a
                    href={appLinkInfo(app).href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-2 text-drop-600 dark:text-drop-400 hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>{appLinkInfo(app).label}</span>
                  </a>
                )}
                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                  <Clock className="w-4 h-4" />
                  <span>{formatDate(app.lastDeployedAt)}</span>
                </div>
                {isAdmin && app.ownerName && (
                  <div className="flex items-center gap-2 text-gray-400">
                    <User className="w-4 h-4" />
                    <span>{app.ownerName}</span>
                  </div>
                )}
              </div>

              {app.error && (
                <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/30 rounded text-xs text-red-600 dark:text-red-400 truncate">
                  {app.error}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default AppsPage;
