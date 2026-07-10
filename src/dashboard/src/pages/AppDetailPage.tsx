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
  GitBranch,
  Activity,
  Globe,
  Terminal,
} from 'lucide-react';
import { useApp, appAction, deleteApp, gitRedeploy } from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { appLinkInfo } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import DeployTimeline from '../components/DeployTimeline';
import LogViewer from '../components/LogViewer';
import Tabs, { TabDef } from '../components/Tabs';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const DETAIL_TABS: TabDef[] = [
  { id: 'logs', label: 'Logs', icon: Terminal },
  { id: 'metrics', label: 'Metrics', icon: Activity },
  { id: 'environment', label: 'Environment', icon: Key },
  { id: 'domains', label: 'Domains', icon: Globe },
];

function AppDetailPage() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const { app, loading, error, refresh } = useApp(name || '');
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('logs');

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
      toast(
        'success',
        `${action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted'} ${name}`
      );
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
        setEnvVars(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
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
        setEnvVars(prev => prev.filter(k => k !== key));
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
          <div className="mb-4 h-8 w-48 rounded" style={{ background: 'var(--bg-2)' }} />
          <div className="h-4 w-96 rounded" style={{ background: 'var(--bg-2)' }} />
        </div>
      </div>
    );
  }

  if (error || !app) {
    return (
      <div className="p-6">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-2 text-sm transition-opacity hover:opacity-70"
          style={{ color: 'var(--text-2)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to apps
        </Link>
        <div
          className="rounded-lg border p-4 text-sm"
          style={{
            borderColor: 'var(--err)',
            background: 'color-mix(in srgb, var(--err) 10%, transparent)',
            color: 'var(--err)',
          }}
        >
          {error || 'App not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Back link */}
      <Link
        to="/"
        className="mb-6 inline-flex items-center gap-2 text-sm transition-opacity hover:opacity-70"
        style={{ color: 'var(--text-2)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to apps
      </Link>

      {/* Header: name, status, type + destructive/lifecycle actions (visible regardless of tab) */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
              {app.name}
            </h1>
            <StatusBadge status={app.status} />
          </div>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            {app.type} application
            {app.framework && ` (${app.framework})`}
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {app.status === 'running' ? (
            <>
              <Button
                variant="secondary"
                onClick={() => handleAction('restart')}
                disabled={actionLoading !== null}
                style={{ color: 'var(--warn)' }}
              >
                <RotateCw
                  className={`h-4 w-4 ${actionLoading === 'restart' ? 'animate-spin' : ''}`}
                />
                Restart
              </Button>
              <Button
                variant="danger"
                onClick={() => handleAction('stop')}
                disabled={actionLoading !== null}
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              onClick={() => handleAction('start')}
              disabled={actionLoading !== null}
            >
              <Play className="h-4 w-4" />
              Start
            </Button>
          )}
          {app.gitSource && (
            <Button
              variant="secondary"
              onClick={handleRedeploy}
              disabled={actionLoading !== null}
              style={{ color: 'var(--accent)' }}
            >
              <RotateCw
                className={`h-4 w-4 ${actionLoading === 'redeploy' ? 'animate-spin' : ''}`}
              />
              Redeploy
            </Button>
          )}
          <Button variant="danger" onClick={handleDelete} disabled={actionLoading !== null}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card>
          <div className="mb-1 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
            <ExternalLink className="h-4 w-4" />
            <span className="text-sm">URL</span>
          </div>
          {app.port ? (
            <a
              href={appLinkInfo(app).href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-sm font-semibold hover:underline"
            >
              {appLinkInfo(app).label}
            </a>
          ) : (
            <span className="text-sm font-semibold" style={{ color: 'var(--text-3)' }}>
              Not assigned
            </span>
          )}
        </Card>

        {isAdmin && app.path ? (
          <Card>
            <div className="mb-1 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
              <Folder className="h-4 w-4" />
              <span className="text-sm">Path</span>
            </div>
            <p
              className="truncate font-mono text-sm"
              style={{ color: 'var(--text)' }}
              title={app.path}
            >
              {app.path}
            </p>
            {app.ownerName && (
              <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
                Owner: {app.ownerName}
              </p>
            )}
          </Card>
        ) : (
          <Card>
            <div className="mb-1 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
              <Folder className="h-4 w-4" />
              <span className="text-sm">Type</span>
            </div>
            <p className="text-sm capitalize" style={{ color: 'var(--text)' }}>
              {app.type}
              {app.framework ? ` (${app.framework})` : ''}
            </p>
          </Card>
        )}

        <Card>
          <div className="mb-1 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
            <Clock className="h-4 w-4" />
            <span className="text-sm">Last Deployed</span>
          </div>
          <p className="text-sm" style={{ color: 'var(--text)' }}>
            {formatDate(app.lastDeployedAt)}
          </p>
          {app.buildDuration && (
            <p className="text-xs" style={{ color: 'var(--text-2)' }}>
              Build: {app.buildDuration}ms
            </p>
          )}
        </Card>
      </div>

      {/* Deploy timeline */}
      <DeployTimeline appName={app.name} />

      {/* Git source info */}
      {app.gitSource && (
        <Card className="mb-6">
          <div className="mb-3 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
            <GitBranch className="h-4 w-4" />
            <span className="text-sm font-medium">Git Source</span>
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <span style={{ color: 'var(--text-2)' }}>Repository: </span>
              <a
                href={app.gitSource.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                {app.gitSource.repoUrl.replace('https://github.com/', '')}
              </a>
            </div>
            <div>
              <span style={{ color: 'var(--text-2)' }}>Branch: </span>
              <span className="font-mono" style={{ color: 'var(--text)' }}>
                {app.gitSource.branch}
              </span>
            </div>
            {app.gitSource.lastCommitSha && (
              <div>
                <span style={{ color: 'var(--text-2)' }}>Commit: </span>
                <span className="font-mono" style={{ color: 'var(--text)' }}>
                  {app.gitSource.lastCommitSha.slice(0, 7)}
                </span>
              </div>
            )}
            <div>
              <span style={{ color: 'var(--text-2)' }}>Auto-redeploy: </span>
              <span style={{ color: 'var(--text)' }}>
                {app.gitSource.autoRedeploy ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Error message */}
      {app.error && (
        <div
          className="mb-6 rounded-lg border p-4 text-sm"
          style={{
            borderColor: 'var(--err)',
            background: 'color-mix(in srgb, var(--err) 10%, transparent)',
            color: 'var(--err)',
          }}
        >
          <strong>Error:</strong> {app.error}
        </div>
      )}

      {/* Deep-view tabs: Logs / Metrics / Environment / Domains */}
      <Tabs tabs={DETAIL_TABS} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'logs' && <LogViewer appName={app.name} appStatus={app.status} />}

      {activeTab === 'metrics' && (
        <Card className="py-12 text-center">
          <Activity className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--text-3)' }} />
          <h3 className="mb-1 text-base font-semibold" style={{ color: 'var(--text)' }}>
            Metrics — coming soon
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Per-app CPU, memory and uptime land in PRD-048.
          </p>
        </Card>
      )}

      {activeTab === 'environment' && (
        <Card padded={false}>
          <div
            className="flex items-center border-b px-4 py-3"
            style={{ borderColor: 'var(--border)' }}
          >
            <Key className="mr-2 h-4 w-4" style={{ color: 'var(--text-2)' }} />
            <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
              Environment Variables
            </h2>
          </div>
          <div className="p-4">
            {envLoading ? (
              <div className="h-8 animate-pulse rounded" style={{ background: 'var(--bg-2)' }} />
            ) : (
              <>
                {envVars.length > 0 && (
                  <div className="mb-4 space-y-2">
                    {envVars.map(key => (
                      <div key={key} className="flex items-center gap-2 text-sm">
                        <span
                          className="min-w-[120px] font-mono font-medium"
                          style={{ color: 'var(--text)' }}
                        >
                          {key}
                        </span>
                        <span
                          className="flex-1 truncate font-mono"
                          style={{ color: 'var(--text-2)' }}
                        >
                          ••••••••
                        </span>
                        {role !== 'readonly' && (
                          <button
                            onClick={() => handleRemoveEnvVar(key)}
                            className="transition-opacity hover:opacity-70"
                            style={{ color: 'var(--text-3)' }}
                            aria-label={`Remove ${key}`}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {envVars.length === 0 && (
                  <p className="mb-4 text-sm" style={{ color: 'var(--text-2)' }}>
                    No environment variables set
                  </p>
                )}

                {role !== 'readonly' && (
                  <>
                    {/* Add new */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex-1">
                        <Input
                          type="text"
                          value={newKey}
                          onChange={e => setNewKey(e.target.value.toUpperCase())}
                          placeholder="KEY"
                          className="font-mono"
                        />
                      </div>
                      <div className="flex-1">
                        <Input
                          type="text"
                          value={newValue}
                          onChange={e => setNewValue(e.target.value)}
                          placeholder="value"
                          className="font-mono"
                        />
                      </div>
                      <Button variant="primary" onClick={handleAddEnvVar} disabled={!newKey.trim()}>
                        <Plus className="h-3.5 w-3.5" />
                        Add
                      </Button>
                    </div>
                    <p className="mt-2 text-xs" style={{ color: 'var(--text-2)' }}>
                      Changes take effect on next restart.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </Card>
      )}

      {activeTab === 'domains' && (
        <CustomDomainSection
          appName={app.name}
          currentDomain={app.customDomain}
          onUpdate={refresh}
        />
      )}
    </div>
  );
}

function CustomDomainSection({
  appName,
  currentDomain,
  onUpdate,
}: {
  appName: string;
  currentDomain?: string;
  onUpdate: () => void;
}) {
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
    <Card>
      <div className="mb-3 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
        <Globe className="h-4 w-4" />
        <span className="text-sm font-medium">Custom Domain</span>
      </div>
      <div className="flex max-w-md gap-2">
        <div className="flex-1">
          <Input
            type="text"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            placeholder="myapp.example.com"
          />
        </div>
        <Button variant="primary" onClick={handleSave} loading={saving}>
          Save
        </Button>
      </div>
      {currentDomain && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-2)' }}>
          Point a CNAME record for <code>{currentDomain}</code> to your DROP server.
        </p>
      )}
    </Card>
  );
}

export default AppDetailPage;
