import { Link } from 'react-router-dom';
import { RefreshCw, ExternalLink, Clock, Cpu } from 'lucide-react';
import { useApps } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';

function AppsPage() {
  const { apps, loading, error, refresh } = useApps();

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
          <h1 className="text-2xl font-bold text-gray-900">Applications</h1>
          <p className="text-gray-500">Manage your deployed applications</p>
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

      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && apps.length === 0 && (
        <div className="text-center py-12">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Cpu className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No applications</h3>
          <p className="text-gray-500 max-w-md mx-auto">
            Drop a folder into the webapps directory to deploy your first application.
          </p>
          <code className="mt-4 inline-block bg-gray-100 px-4 py-2 rounded text-sm">
            C:\drop\data\webapps\
          </code>
        </div>
      )}

      {/* Apps grid */}
      {apps.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <Link
              key={app.name}
              to={`/apps/${app.name}`}
              className="block bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md hover:border-drop-300 transition-all"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{app.name}</h3>
                  <p className="text-sm text-gray-500">{app.type}</p>
                </div>
                <StatusBadge status={app.status} />
              </div>

              <div className="space-y-2 text-sm">
                {app.port && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <ExternalLink className="w-4 h-4" />
                    <span>localhost:{app.port}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-gray-600">
                  <Clock className="w-4 h-4" />
                  <span>Deployed: {formatDate(app.lastDeployedAt)}</span>
                </div>
              </div>

              {app.error && (
                <div className="mt-3 p-2 bg-red-50 rounded text-xs text-red-600 truncate">
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
