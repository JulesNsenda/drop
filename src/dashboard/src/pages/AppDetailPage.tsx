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
  Key,
  Plus,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useApp, appAction, deleteApp, gitRedeploy } from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';

function AppDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { app, loading, error, refresh } = useApp(name || '');
  const { toast } = useToast();
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Env vars state
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envLoading, setEnvLoading] = useState(false);
  const [showValues, setShowValues] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Fetch logs
  useEffect(() => {
    if (!name) return;
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/v1/logs/${name}?lines=100`, { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success && json.data?.logs) {
          setLogs(json.data.logs);
        }
      } catch {
        // Ignore
      } finally {
        setLogsLoading(false);
      }
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [name]);

  // Fetch env vars
  useEffect(() => {
    if (!name) return;
    const fetchEnv = async () => {
      try {
        setEnvLoading(true);
        const res = await fetch(`/api/v1/secrets/${name}`, { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success && json.data) {
          setEnvVars(json.data);
        }
      } catch {
        // Secrets endpoint may not be available
      } finally {
        setEnvLoading(false);
      }
    };
    fetchEnv();
  }, [name]);

  // Auto-scroll logs within the log container only
  useEffect(() => {
    const container = logsEndRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [logs]);

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!name) return;
    setActionLoading(action);
    const success = await appAction(name, action);
    if (success) {
      toast('success', `${action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted'} ${name}`);
    } else {
      toast('error', `Failed to ${action} ${name}`);
    }
    await refresh();
    setActionLoading(null);
  };

  const handleRedeploy = async () => {
    if (!name) return;
    setActionLoading('redeploy');
    const result = await gitRedeploy(name);
    if (result.success) {
      toast('success', `Redeploying ${name}...`);
    } else {
      toast('error', result.error || `Failed to redeploy ${name}`);
    }
    await refresh();
    setActionLoading(null);
  };

  const handleDelete = async () => {
    if (!name) return;
    if (!confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) return;

    setActionLoading('delete');
    const success = await deleteApp(name);
    if (success) {
      toast('success', `Deleted ${name}`);
      navigate('/');
    } else {
      toast('error', `Failed to delete ${name}`);
      setActionLoading(null);
    }
  };

  const handleAddEnvVar = async () => {
    if (!name || !newKey.trim()) return;
    try {
      const res = await fetch(`/api/v1/secrets/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ [newKey.trim()]: newValue }),
      });
      const json = await res.json();
      if (json.success) {
        setEnvVars((prev) => ({ ...prev, [newKey.trim()]: newValue }));
        setNewKey('');
        setNewValue('');
        toast('success', `Added ${newKey.trim()}`);
      }
    } catch {
      toast('error', 'Failed to add environment variable');
    }
  };

  const handleRemoveEnvVar = async (key: string) => {
    if (!name) return;
    try {
      const res = await fetch(`/api/v1/secrets/${name}/${key}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (json.success) {
        setEnvVars((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        toast('success', `Removed ${key}`);
      }
    } catch {
      toast('error', 'Failed to remove environment variable');
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const handleDownloadLogs = async () => {
    if (!name) return;
    try {
      const res = await fetch(`/api/v1/logs/${name}?lines=1000`, { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success && json.data?.logs) {
        const content = json.data.logs.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}-${new Date().toISOString().split('T')[0]}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      toast('error', 'Failed to download logs');
    }
  };

  if (loading && !app) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded mb-4" />
          <div className="h-4 w-96 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="p-6">
        <Link to="/" className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6">
          <ArrowLeft className="w-4 h-4" />
          Back to apps
        </Link>
        <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
          {error || 'App not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Back link */}
      <Link to="/" className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to apps
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{app.name}</h1>
            <StatusBadge status={app.status} />
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            {app.type} application
            {app.framework && ` (${app.framework})`}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {app.status === 'running' ? (
            <>
              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading !== null}
                className="flex items-center gap-2 px-3 py-2 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-lg hover:bg-yellow-200 dark:hover:bg-yellow-900/50 disabled:opacity-50"
              >
                <RotateCw className={`w-4 h-4 ${actionLoading === 'restart' ? 'animate-spin' : ''}`} />
                Restart
              </button>
              <button
                onClick={() => handleAction('stop')}
                disabled={actionLoading !== null}
                className="flex items-center gap-2 px-3 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50"
              >
                <Square className="w-4 h-4" />
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={() => handleAction('start')}
              disabled={actionLoading !== null}
              className="flex items-center gap-2 px-3 py-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              Start
            </button>
          )}
          {app.gitSource && (
            <button
              onClick={handleRedeploy}
              disabled={actionLoading !== null}
              className="flex items-center gap-2 px-3 py-2 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 disabled:opacity-50"
            >
              <RotateCw className={`w-4 h-4 ${actionLoading === 'redeploy' ? 'animate-spin' : ''}`} />
              Redeploy
            </button>
          )}
          <button
            onClick={handleDelete}
            disabled={actionLoading !== null}
            className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-400 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
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

        {isAdmin && app.path ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
              <Folder className="w-4 h-4" />
              <span className="text-sm">Path</span>
            </div>
            <p className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate" title={app.path}>
              {app.path}
            </p>
            {app.ownerName && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Owner: {app.ownerName}</p>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
              <Folder className="w-4 h-4" />
              <span className="text-sm">Type</span>
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300 capitalize">{app.type}{app.framework ? ` (${app.framework})` : ''}</p>
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-1">
            <Clock className="w-4 h-4" />
            <span className="text-sm">Last Deployed</span>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">{formatDate(app.lastDeployedAt)}</p>
          {app.buildDuration && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Build: {app.buildDuration}ms</p>
          )}
        </div>
      </div>

      {/* Custom domain */}
      <CustomDomainSection appName={app.name} currentDomain={app.customDomain} onUpdate={refresh} />

      {/* Git source info */}
      {app.gitSource && (
        <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 mb-3">
            <span className="text-sm font-medium">Git Source</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 text-sm">
            <div>
              <span className="text-gray-500 dark:text-gray-400">Repository: </span>
              <a
                href={app.gitSource.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-drop-600 hover:underline"
              >
                {app.gitSource.repoUrl.replace('https://github.com/', '')}
              </a>
            </div>
            <div>
              <span className="text-gray-500 dark:text-gray-400">Branch: </span>
              <span className="text-gray-700 dark:text-gray-300 font-mono">{app.gitSource.branch}</span>
            </div>
            {app.gitSource.lastCommitSha && (
              <div>
                <span className="text-gray-500 dark:text-gray-400">Commit: </span>
                <span className="text-gray-700 dark:text-gray-300 font-mono">
                  {app.gitSource.lastCommitSha.slice(0, 7)}
                </span>
              </div>
            )}
            <div>
              <span className="text-gray-500 dark:text-gray-400">Auto-redeploy: </span>
              <span className="text-gray-700 dark:text-gray-300">
                {app.gitSource.autoRedeploy ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Error message */}
      {app.error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400">
          <strong>Error:</strong> {app.error}
        </div>
      )}

      {/* Environment Variables */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Environment Variables</h2>
          </div>
          <button
            onClick={() => setShowValues(!showValues)}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            {showValues ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {showValues ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="p-4">
          {envLoading ? (
            <div className="animate-pulse h-8 bg-gray-100 dark:bg-gray-700 rounded" />
          ) : (
            <>
              {Object.keys(envVars).length > 0 && (
                <div className="space-y-2 mb-4">
                  {Object.entries(envVars).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-medium text-gray-700 dark:text-gray-300 min-w-[120px]">
                        {key}
                      </span>
                      <span className="flex-1 font-mono text-gray-500 dark:text-gray-400 truncate">
                        {showValues ? value : '••••••••'}
                      </span>
                      <button
                        onClick={() => handleRemoveEnvVar(key)}
                        className="text-gray-400 hover:text-red-500"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(envVars).length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  No environment variables set
                </p>
              )}

              {/* Add new */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value.toUpperCase())}
                  placeholder="KEY"
                  className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono outline-none focus:ring-1 focus:ring-drop-500"
                />
                <input
                  type="text"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="value"
                  className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono outline-none focus:ring-1 focus:ring-drop-500"
                />
                <button
                  onClick={handleAddEnvVar}
                  disabled={!newKey.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm bg-drop-600 text-white rounded hover:bg-drop-700 disabled:opacity-50"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Logs */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Logs</h2>
            {logsLoading && <span className="text-xs text-gray-400">(loading...)</span>}
          </div>
          <button
            onClick={handleDownloadLogs}
            className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            title="Download logs"
          >
            <Download className="w-4 h-4" />
            Download
          </button>
        </div>
        <div className="h-96 overflow-auto bg-gray-900 dark:bg-gray-950 p-4 font-mono text-sm">
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

function CustomDomainSection({ appName, currentDomain, onUpdate }: { appName: string; currentDomain?: string; onUpdate: () => void }) {
  const [domain, setDomain] = useState(currentDomain || '');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/apps/${appName}/domain`, {
        method: 'PUT',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim() || undefined }),
      });
      const json = await res.json();
      if (json.success) {
        toast('success', domain.trim() ? `Domain set to ${domain.trim()}` : 'Domain removed');
        onUpdate();
      } else {
        toast('error', json.error?.message || 'Failed');
      }
    } catch {
      toast('error', 'Network error');
    }
    setSaving(false);
  };

  return (
    <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Custom Domain</div>
      <div className="flex gap-2 max-w-md">
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="myapp.example.com"
          className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {currentDomain && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Point a CNAME record for <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{currentDomain}</code> to your DROP server.
        </p>
      )}
    </div>
  );
}

export default AppDetailPage;
