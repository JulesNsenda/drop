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
  Plug,
  Key,
  Plus,
  X,
  GitBranch,
  Activity,
  Globe,
  Terminal,
  AlertTriangle,
  Database,
  Lock,
} from 'lucide-react';
import {
  useApp,
  appAction,
  deleteApp,
  gitRedeploy,
  getGitTokens,
  GitTokenInfo,
} from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { appLinkInfo } from '../api/client';
import {
  CREDENTIAL_CLEAR,
  CREDENTIAL_UNCHANGED,
  credentialChoiceToTokenId,
} from '../lib/redeploy-credential';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import StatusBadge from '../components/StatusBadge';
import DeployTimeline from '../components/DeployTimeline';
import LogViewer from '../components/LogViewer';
import Tabs, { TabDef } from '../components/Tabs';
import MetricsTab from '../components/MetricsTab';
import DatabaseTab from '../components/DatabaseTab';
import AccessTab from '../components/AccessTab';
import ShareCard from '../components/ShareCard';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

// Always visible — the "no database provisioned" state is first-class
// content, not something to hide behind a conditional tab (see DROP-120 plan).
/** Matches the `Input` primitive's look for a native control it doesn't cover (mirrors DeployPage's `inlineFieldClass`). */
const inlineSelectClass = 'rounded-lg px-3 py-2 text-sm outline-none transition-colors dui-input';

const DETAIL_TABS: TabDef[] = [
  { id: 'logs', label: 'Logs', icon: Terminal },
  { id: 'metrics', label: 'Metrics', icon: Activity },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'environment', label: 'Environment', icon: Key },
  { id: 'domains', label: 'Domains', icon: Globe },
  // Governance, not runtime — but it belongs beside the app it governs rather
  // than in a separate estate screen, because the question "who may open this"
  // is asked while looking at the app.
  { id: 'access', label: 'Access', icon: Lock },
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

  // Git credential to send with the next redeploy (DROP-142)
  const [gitTokens, setGitTokens] = useState<GitTokenInfo[]>([]);
  const [credentialChoice, setCredentialChoice] = useState<string>(CREDENTIAL_UNCHANGED);

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

  // A monorepo child has no gitSource of its own, but its git-backed group can
  // still be redeployed — the server resolves the child to its container and
  // re-pulls + re-expands the whole group.
  const isGroupChild = !app?.gitSource && !!app?.groupGitBacked;
  const canRedeploy = !!app?.gitSource || isGroupChild;

  // Stored git credentials, for attaching one to an app whose repo went
  // private. `/git/tokens` is a `user`-role route while this page is reachable
  // at `readonly`, so gate the FETCH, not just the render — an ungated call
  // 403s for every read-only viewer.
  const canManageCredential = canRedeploy && role !== 'readonly';

  // Rendered for admins ONLY, deliberately: `toAppDto` gates `tokenId` on the
  // admin tier (it is a correlation handle), so a `user` always reads
  // `undefined` here and would be told "None" about an app that does have a
  // credential attached. A lie is worse than an absent field.
  const attachedTokenId = app?.gitSource?.tokenId;
  const attachedTokenLabel = attachedTokenId
    ? (gitTokens.find(t => t.id === attachedTokenId)?.name ??
      'attached (no longer in the token store)')
    : 'None — public repo';
  // `apps/:name` has no route `key`, so React Router REUSES this component
  // instance when only the name changes — every other name-scoped value here
  // is re-derived from `name`, but a plain useState is not. Without this,
  // picking a token on app A and then navigating to app B and pressing
  // Redeploy attaches A's credential to B (and "Clear stored credential"
  // carries over the same way, stripping B's).
  useEffect(() => {
    setCredentialChoice(CREDENTIAL_UNCHANGED);
  }, [name]);

  useEffect(() => {
    if (!canManageCredential) return;
    let cancelled = false;
    getGitTokens()
      .then(list => {
        if (!cancelled) setGitTokens(list);
      })
      .catch(() => {
        // Token list is an enhancement to the redeploy button, not a
        // prerequisite for it — a failure here must not break the page.
      });
    return () => {
      cancelled = true;
    };
  }, [canManageCredential]);

  const handleRedeploy = async () => {
    if (!name) return;
    setActionLoading('redeploy');
    // Three states, deliberately: neutral → omit the key (leave the stored
    // token alone), CLEAR → null, an id → attach/replace.
    const wasClear = credentialChoice === CREDENTIAL_CLEAR;
    const result = await gitRedeploy(name, credentialChoiceToTokenId(credentialChoice));
    if (result.success) {
      toast('success', isGroupChild ? `Redeploying group ${app?.group}...` : `Redeploying ${name}...`);
    } else {
      toast('error', result.error || `Failed to redeploy ${name}`);
    }
    // Back to neutral so the next redeploy doesn't re-send the change — but
    // the two directions clear at different times, because the server
    // persists them at different times. An ATTACH is written only after a
    // successful pull, so on failure the selection must survive for the
    // retry. A CLEAR is written BEFORE the pull (revocation is not a deploy
    // outcome), so it has already happened whatever the pull did, and leaving
    // the select on "Clear stored credential" would describe a pending change
    // that isn't pending.
    if (result.success || wasClear) {
      setCredentialChoice(CREDENTIAL_UNCHANGED);
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

  // `!app`, NOT `error || !app`. This page polls every 3s, so gating on `error`
  // meant a single transient poll failure tore down a fully-rendered page —
  // tabs, logs, scroll position and all — and the next poll built it again. An
  // error we can show *beside* the data belongs in a banner (see below), not in
  // place of it.
  if (!app) {
    return (
      <div className="p-6">
        <Link
          to="/apps"
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
        to="/apps"
        className="mb-6 inline-flex items-center gap-2 text-sm transition-opacity hover:opacity-70"
        style={{ color: 'var(--text-2)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to apps
      </Link>

      {/* A refresh that failed while the page already had data: surfaced, but
          non-destructive — the last good snapshot stays on screen. */}
      {error && (
        <div
          role="alert"
          className="mb-6 rounded-lg border p-4 text-sm"
          style={{
            borderColor: 'var(--err)',
            background: 'color-mix(in srgb, var(--err) 10%, transparent)',
            color: 'var(--err)',
          }}
        >
          {error}
        </div>
      )}

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
          {canRedeploy && (
            <>
              {/* Feeds the EXISTING Redeploy button rather than adding a second
                  one. Lives here, not in the Git Source card below, because
                  that card is gated on `app.gitSource` and a monorepo child has
                  none — it would silently lose the picker on the group path. */}
              {/* Gated on the ROLE alone, never on `gitTokens.length` — the
                  operator who has just deleted a leaked PAT from the token
                  store is exactly the one who needs "Clear stored credential",
                  and an empty list would have taken the whole control away. */}
              {canManageCredential && (
                <select
                  value={credentialChoice}
                  onChange={e => setCredentialChoice(e.target.value)}
                  className={inlineSelectClass}
                  disabled={actionLoading !== null}
                  aria-label="Git credential for this redeploy"
                  title={
                    gitTokens.length === 0
                      ? 'No stored credentials yet — add one on the Deploy page'
                      : 'Attach a stored credential — for a repo that has become private'
                  }
                >
                  {/* Every option must carry either a sentinel or a real token
                      id: a duplicated value would break the controlled select,
                      and an unrecognised one is sent verbatim and 400s. */}
                  <option value={CREDENTIAL_UNCHANGED}>Credential: leave as is</option>
                  {gitTokens.map(t => (
                    <option key={t.id} value={t.id}>
                      Use token: {t.name}
                    </option>
                  ))}
                  <option value={CREDENTIAL_CLEAR}>Clear stored credential</option>
                </select>
              )}
              <Button
                variant="secondary"
                onClick={handleRedeploy}
                disabled={actionLoading !== null}
                style={{ color: 'var(--accent)' }}
                title={
                  isGroupChild
                    ? `Re-pull and rebuild the whole ${app.group} monorepo group`
                    : undefined
                }
              >
                <RotateCw
                  className={`h-4 w-4 ${actionLoading === 'redeploy' ? 'animate-spin' : ''}`}
                />
                {isGroupChild ? 'Redeploy group' : 'Redeploy'}
              </Button>
            </>
          )}
          <Button variant="danger" onClick={handleDelete} disabled={actionLoading !== null}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      {/* Needs-config banner — app declared required secrets that aren't set,
          so DROP parked it instead of crash-looping. Actionable, not an error. */}
      {app.status === 'needs-config' && (
        <div
          className="mb-6 rounded-lg border p-4"
          style={{
            borderColor: 'var(--warn)',
            background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
          }}
        >
          <div className="mb-2 flex items-center gap-2" style={{ color: 'var(--warn)' }}>
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <p className="text-sm font-medium">Waiting on required secrets</p>
          </div>
          <p className="mb-3 text-sm" style={{ color: 'var(--text-2)' }}>
            This app declared required secrets in its <code>drop.yaml</code> that aren&apos;t set
            yet, so DROP parked it instead of starting it.
            {app.missingSecrets && app.missingSecrets.length > 0
              ? ' Set the values below, then retry:'
              : ' Set the required secrets below, then retry.'}
          </p>
          {app.missingSecrets && app.missingSecrets.length > 0 && (
            <ul className="mb-3 space-y-1">
              {app.missingSecrets.map(key => (
                <li key={key} className="font-mono text-sm" style={{ color: 'var(--text)' }}>
                  {key}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setActiveTab('environment')}
              disabled={actionLoading !== null}
            >
              <Key className="h-4 w-4" />
              Add environment variable
            </Button>
            <Button
              variant="secondary"
              onClick={() => handleAction('restart')}
              disabled={actionLoading !== null}
              style={{ color: 'var(--warn)' }}
            >
              <RotateCw
                className={`h-4 w-4 ${actionLoading === 'restart' ? 'animate-spin' : ''}`}
              />
              Retry deploy
            </Button>
          </div>
        </div>
      )}

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

        {app.mcp ? (
          <Card>
            <div className="mb-1 flex items-center gap-2" style={{ color: 'var(--text-2)' }}>
              <Plug className="h-4 w-4" />
              <span className="text-sm">MCP endpoint</span>
            </div>
            <p className="break-all text-sm font-semibold" style={{ color: 'var(--text)' }}>
              {app.mcp.url}
            </p>
            {/*
              Shown with the URL, never separately: an operator handed only an
              address would reasonably assume DROP guards it, and for `auth:
              none` it does not.

              This used to say "Public" unconditionally, ignoring `mcp.auth`
              — wrong for every `auth: drop` app, where the Caddy forward_auth
              gateway DOES verify an audience-bound token (see
              routes/mcp-gateway.ts).

              The wording is deliberately "guarded at the proxy", not
              "protected": the guard lives ONLY in Caddy. platform.ts logs the
              two counter-cases itself — outside docker isolation the app binds
              a host port that is reachable directly, bypassing it, and when
              apiPort is unusable the guard is not emitted at all. `mcp.auth`
              is the tenant's DECLARATION, not proof of enforcement, so this
              must not promise more than the declaration supports.
            */}
            <p className="mt-1 text-xs" style={{ color: 'var(--text-3)' }}>
              {app.mcp.auth === 'drop'
                ? 'Guarded at the proxy — DROP verifies an audience-bound token on requests that arrive through it. Traffic reaching the app’s own port directly is not covered.'
                : 'Public — DROP does not authenticate callers to this endpoint.'}
            </p>
          </Card>
        ) : null}

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
            {isAdmin && (
              <div>
                <span style={{ color: 'var(--text-2)' }}>Credential: </span>
                <span style={{ color: 'var(--text)' }}>{attachedTokenLabel}</span>
              </div>
            )}
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

      {/* Deep-view tabs: Logs / Metrics / Database / Environment / Domains */}
      <Tabs tabs={DETAIL_TABS} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'logs' && <LogViewer appName={app.name} appStatus={app.status} />}

      {activeTab === 'metrics' && <MetricsTab app={app} />}

      {activeTab === 'database' && <DatabaseTab name={app.name} />}

      {/* Admins keep the full governance view; a non-admin owner gets the
          narrower, WRITE-capable share panel instead — `AccessTab`'s allow-list
          and provenance are exactly what `ShareCard` withholds from the party
          it would otherwise disclose (DROP-153). */}
      {activeTab === 'access' && (isAdmin ? <AccessTab appName={app.name} /> : <ShareCard appName={app.name} />)}

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
