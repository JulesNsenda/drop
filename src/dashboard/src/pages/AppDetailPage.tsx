import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCw,
  Trash2,
  ExternalLink,
  Clock,
  Folder,
  Key,
  Plus,
  X,
} from 'lucide-react';
import { useApp, appAction, deleteApp, gitRedeploy } from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { appLinkInfo } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import DeployTimeline from '../components/DeployTimeline';
import LogViewer from '../components/LogViewer';

function AppDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { app, loading, error, refresh } = useApp(name || '');
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Env vars state — keys only; values are never returned by the API
  const [envVars, setEnvVars] = useState<string[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Fetch env vars
  useEffect(() => {
    if (!name) return;
    const fetchEnv = async () => {
      try {
        setEnvLoading(true);
        const res = await fetch(`/api/v1/secrets/${name}`, { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success && json.data) {
          setEnvVars(json.data.keys ?? []);
        }
      } catch {
        // Secrets endpoint may not be available
      } finally {
        setEnvLoading(false);
      }
    };
    fetchEnv();
  }, [name]);

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
    const confirmed = await confirmDialog({
      title: 'Delete application',
      message: `Are you sure you want to delete "${name}"? This will remove the app and all its files permanently.`,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

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
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      });
      const json = await res.json();
      if (json.success) {
        const trimmed = newKey.trim();
        setEnvVars((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
        setNewKey('');
        setNewValue('');
        toast('success', `Added ${trimmed}`);
      } else {
        toast('error', json.error?.message || 'Failed to add environment variable');
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
        setEnvVars((prev) => prev.filter((k) => k !== key));
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
            <span className="text-sm">URL</span>
          </div>
          {app.port ? (
            <a
              href={appLinkInfo(app).href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-drop-600 hover:underline break-all"
            >
              {appLinkInfo(app).label}
            </a>
          ) : (
            <span className="text-sm font-semibold text-gray-400">Not assigned</span>
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

      {/* Deploy timeline */}
      <DeployTimeline appName={app.name} />

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
        <div className="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <Key className="w-4 h-4 text-gray-500 dark:text-gray-400 mr-2" />
          <h2 className="font-semibold text-gray-900 dark:text-white">Environment Variables</h2>
        </div>
        <div className="p-4">
          {envLoading ? (
            <div className="animate-pulse h-8 bg-gray-100 dark:bg-gray-700 rounded" />
          ) : (
            <>
              {envVars.length > 0 && (
                <div className="space-y-2 mb-4">
                  {envVars.map((key) => (
                    <div key={key} className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-medium text-gray-700 dark:text-gray-300 min-w-[120px]">
                        {key}
                      </span>
                      <span className="flex-1 font-mono text-gray-500 dark:text-gray-400 truncate">
                        ••••••••
                      </span>
                      {role !== 'readonly' && (
                        <button
                          onClick={() => handleRemoveEnvVar(key)}
                          className="text-gray-400 hover:text-red-500"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {envVars.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  No environment variables set
                </p>
              )}

              {role !== 'readonly' && (
                <>
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
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Changes take effect on next restart.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Logs */}
      <LogViewer appName={app.name} appStatus={app.status} />
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
