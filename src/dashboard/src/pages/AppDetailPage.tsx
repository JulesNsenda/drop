import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  Trash2,
  ExternalLink,
  Terminal,
  Clock,
  Folder,
  Download,
} from 'lucide-react';
import { useApp, appAction, deleteApp } from '../hooks/useApi';
import StatusBadge from '../components/StatusBadge';

function AppDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { app, loading, error, refresh } = useApp(name || '');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Fetch logs
  useEffect(() => {
    if (!name) return;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/v1/logs/${name}?lines=100`);
        const json = await res.json();
        if (json.success && json.data?.logs) {
          setLogs(json.data.logs);
        }
      } catch {
        // Ignore errors
      } finally {
        setLogsLoading(false);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [name]);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!name) return;
    setActionLoading(action);
    await appAction(name, action);
    await refresh();
    setActionLoading(null);
  };

  const handleDelete = async () => {
    if (!name) return;
    if (!confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) {
      return;
    }
    setActionLoading('delete');
    const success = await deleteApp(name);
    if (success) {
      navigate('/');
    } else {
      setActionLoading(null);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const handleDownloadLogs = async () => {
    if (!name) return;
    try {
      // Fetch more logs for download (1000 lines)
      const res = await fetch(`/api/v1/logs/${name}?lines=1000`);
      const json = await res.json();
      if (json.success && json.data?.logs) {
        const content = json.data.logs.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const today = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `${name}-${today}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      alert('Failed to download logs');
    }
  };

  if (loading && !app) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-gray-200 rounded mb-4" />
          <div className="h-4 w-96 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="p-6">
        <Link to="/" className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6">
          <ArrowLeft className="w-4 h-4" />
          Back to apps
        </Link>
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error || 'App not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Back link */}
      <Link to="/" className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to apps
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>
            <StatusBadge status={app.status} />
          </div>
          <p className="text-gray-500">{app.type} application</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {app.status === 'running' ? (
            <>
              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading !== null}
                className="flex items-center gap-2 px-3 py-2 bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200 disabled:opacity-50"
              >
                <RotateCw className={`w-4 h-4 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
                Restart
              </button>
              <button
                onClick={() => handleAction('stop')}
                disabled={actionLoading !== null}
                className="flex items-center gap-2 px-3 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
              >
                <Square className="w-4 h-4" />
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading !== null}
              className="flex items-center gap-2 px-3 py-2 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              Start
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={actionLoading !== null}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-3 mb-6">
        {/* Port */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-1">
            <ExternalLink className="w-4 h-4" />
            <span className="text-sm">Port</span>
          </div>
          {app.port ? (
            <a
              href={`http://localhost:${app.port}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-semibold text-drop-600 hover:underline"
            >
              localhost:{app.port}
            </a>
          ) : (
            <span className="text-lg font-semibold text-gray-400">Not assigned</span>
          )}
        </div>

        {/* Path */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-1">
            <Folder className="w-4 h-4" />
            <span className="text-sm">Path</span>
          </div>
          <p className="text-sm font-mono text-gray-700 truncate" title={app.path}>
            {app.path}
          </p>
        </div>

        {/* Last deployed */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-gray-500 mb-1">
            <Clock className="w-4 h-4" />
            <span className="text-sm">Last Deployed</span>
          </div>
          <p className="text-sm text-gray-700">{formatDate(app.lastDeployedAt)}</p>
          {app.buildDuration && (
            <p className="text-xs text-gray-500">Build: {app.buildDuration}ms</p>
          )}
        </div>
      </div>

      {/* Error message */}
      {app.error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          <strong>Error:</strong> {app.error}
        </div>
      )}

      {/* Logs */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-gray-500" />
            <h2 className="font-semibold text-gray-900">Logs</h2>
            {logsLoading && <span className="text-xs text-gray-400">(loading...)</span>}
          </div>
          <button
            onClick={handleDownloadLogs}
            className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
            title="Download logs"
          >
            <Download className="w-4 h-4" />
            Download
          </button>
        </div>
        <div className="h-96 overflow-auto bg-gray-900 p-4 font-mono text-sm">
          {logs.length === 0 ? (
            <p className="text-gray-500">No logs available</p>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="text-gray-300 whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}

export default AppDetailPage;
