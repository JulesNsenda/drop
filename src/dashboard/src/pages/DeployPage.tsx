import { useState, useRef, useEffect, DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderUp,
  GitBranch,
  CheckCircle,
  AlertCircle,
  Loader2,
  Key,
  Trash2,
  Plus,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { getAuthHeaders } from '../hooks/useAuth';
import {
  gitDeploy,
  getGitTokens,
  addGitToken,
  deleteGitToken,
  GitTokenInfo,
  useHealth,
} from '../hooks/useApi';
import { appLinkInfo } from '../api/client';
import Tabs, { TabDef } from '../components/Tabs';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';

type Tab = 'github' | 'upload';
type DeployStatus = 'idle' | 'deploying' | 'success' | 'error';

const deployTabs: TabDef[] = [
  { id: 'github', label: 'GitHub', icon: GitBranch },
  { id: 'upload', label: 'Upload', icon: FolderUp },
];

/** Compact select/text-input styling that matches the `Input` primitive's `.dui-input` look for controls the primitive doesn't cover (native `<select>`, inline icon buttons). */
const inlineFieldClass =
  'w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors dui-input';

function DeployPage() {
  const [tab, setTab] = useState<Tab>('github');
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const navigate = useNavigate();
  const { health } = useHealth();

  // Build the "deploy via filesystem" hint from the SERVER's OS and webapps
  // directory (reported by /health), not the browser's — the dashboard is
  // often viewed from a different OS than the one DROP runs on.
  const serverIsWindows = health?.system?.platform === 'win32';
  const appsDir = health?.system?.appsDirectory;
  const filesystemHint = appsDir
    ? serverIsWindows
      ? `copy my-app\\ ${appsDir}\\my-app\\`
      : `cp -r ./my-app ${appsDir}/`
    : null;

  // Shared result state
  const [status, setStatus] = useState<DeployStatus>('idle');
  const [message, setMessage] = useState('');
  const [deployedApp, setDeployedApp] = useState('');
  const [deployStep, setDeployStep] = useState('');

  // Git state
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [gitAppName, setGitAppName] = useState('');
  const [autoRedeploy, setAutoRedeploy] = useState(true);
  const [selectedToken, setSelectedToken] = useState('');
  const [tokens, setTokens] = useState<GitTokenInfo[]>([]);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenValue, setNewTokenValue] = useState('');

  // Upload state
  const [dragOver, setDragOver] = useState(false);
  const [uploadAppName, setUploadAppName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getGitTokens().then(setTokens);
  }, []);

  const resetState = () => {
    setStatus('idle');
    setMessage('');
    setDeployedApp('');
    setRepoUrl('');
    setGitAppName('');
    setBranch('main');
    setUploadAppName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // --- Git Deploy ---
  const handleGitDeploy = async () => {
    if (!repoUrl.trim()) return;
    setStatus('deploying');
    setMessage('');
    setDeployStep('Cloning repository...');

    const result = await gitDeploy({
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      name: gitAppName.trim() || undefined,
      autoRedeploy,
      tokenId: selectedToken || undefined,
    });

    if (result.success && result.data) {
      const appName = result.data.appName;
      setDeployedApp(appName);
      setDeployStep('Building application...');

      // Poll app status until running or errored
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`/api/v1/apps/${appName}`, { headers: getAuthHeaders() });
          const json = await res.json();
          if (json.success && json.data) {
            const appStatus = json.data.status;
            if (appStatus === 'building') setDeployStep('Building application...');
            else if (appStatus === 'starting') setDeployStep('Starting application...');
            else if (appStatus === 'running') {
              clearInterval(poll);
              setStatus('success');
              const { label } = appLinkInfo(json.data);
              setMessage(`${appName} is live${label ? ` at ${label}` : ''}`);
              toast('success', `${appName} deployed!`);
            } else if (appStatus === 'errored') {
              clearInterval(poll);
              setStatus('error');
              setMessage(json.data.error || 'Application failed to start');
            }
          }
        } catch {}
        if (attempts > 60) {
          // 30 second timeout
          clearInterval(poll);
          setStatus('success');
          setMessage(`${appName} is being deployed. Check the app detail for status.`);
        }
      }, 500);
    } else {
      setStatus('error');
      setMessage(result.error || 'Deploy failed');
      toast('error', result.error || 'Deploy failed');
    }
  };

  const handleAddToken = async () => {
    if (!newTokenName.trim() || !newTokenValue.trim()) return;
    const result = await addGitToken(newTokenName.trim(), newTokenValue.trim());
    if (result.success && result.data) {
      setTokens([...tokens, result.data]);
      setNewTokenName('');
      setNewTokenValue('');
      setShowTokenForm(false);
      toast('success', 'Token added');
    } else {
      toast('error', result.error || 'Failed to add token');
    }
  };

  const handleDeleteToken = async (id: string) => {
    const confirmed = await confirmDialog({
      title: 'Delete token',
      message: 'Remove this GitHub token?',
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;
    const deleted = await deleteGitToken(id);
    if (deleted) {
      setTokens(tokens.filter(t => t.id !== id));
      if (selectedToken === id) setSelectedToken('');
      toast('success', 'Token deleted');
    }
  };

  // --- File Upload ---
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) await uploadFiles(e.dataTransfer.files);
  };

  const handleFileSelect = async () => {
    const files = fileInputRef.current?.files;
    if (files && files.length > 0) await uploadFiles(files);
  };

  const uploadFiles = async (files: FileList) => {
    setStatus('deploying');
    setMessage('');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) formData.append('files', files[i]);
    if (uploadAppName.trim()) formData.append('name', uploadAppName.trim());

    try {
      const res = await fetch('/api/v1/apps/deploy', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: formData,
      });
      const json = await res.json();
      if (json.success) {
        setStatus('success');
        setDeployedApp(json.data?.name || '');
        setMessage(json.data?.message || 'Application deployed successfully');
        toast('success', `Deployed ${json.data?.name || 'application'}`);
      } else {
        setStatus('error');
        setMessage(json.error?.message || 'Deployment failed');
        toast('error', json.error?.message || 'Deployment failed');
      }
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Network error');
      toast('error', 'Failed to connect to server');
    }
  };

  // --- Result screens ---
  if (status === 'success') {
    return (
      <div className="p-6">
        <div className="mx-auto mt-12 max-w-lg">
          <Card className="text-center">
            <div
              className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: 'color-mix(in srgb, var(--ok) 15%, transparent)' }}
            >
              <CheckCircle className="h-7 w-7" style={{ color: 'var(--ok)' }} />
            </div>
            <h2 className="mb-2 text-xl font-semibold" style={{ color: 'var(--text)' }}>
              Deployment started
            </h2>
            <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {message}
            </p>
            <div className="flex flex-col justify-center gap-3 sm:flex-row">
              {deployedApp && (
                <Button variant="primary" onClick={() => navigate(`/apps/${deployedApp}`)}>
                  View application
                  <ArrowRight className="h-4 w-4" />
                </Button>
              )}
              <Button variant="secondary" onClick={resetState}>
                Deploy another
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="p-6">
        <div className="mx-auto mt-12 max-w-lg">
          <Card
            className="text-center"
            style={{ borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)' }}
          >
            <div
              className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: 'color-mix(in srgb, var(--err) 15%, transparent)' }}
            >
              <AlertCircle className="h-7 w-7" style={{ color: 'var(--err)' }} />
            </div>
            <h2 className="mb-2 text-xl font-semibold" style={{ color: 'var(--text)' }}>
              Deployment failed
            </h2>
            <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {message}
            </p>
            <Button variant="primary" onClick={() => setStatus('idle')}>
              Try again
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
          Deploy
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          Deploy a new application from GitHub or by uploading files
        </p>
      </div>

      <div className="max-w-2xl">
        <Tabs tabs={deployTabs} active={tab} onChange={id => setTab(id as Tab)} />
      </div>

      {/* GitHub tab */}
      {tab === 'github' && (
        <Card className="max-w-2xl space-y-5">
          <Input
            label="Repository URL"
            type="url"
            value={repoUrl}
            onChange={e => setRepoUrl(e.target.value)}
            placeholder="https://github.com/user/repo"
            disabled={status === 'deploying'}
          />

          {/* Branch + Name row */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Branch"
              type="text"
              value={branch}
              onChange={e => setBranch(e.target.value)}
              placeholder="main"
              disabled={status === 'deploying'}
            />
            <Input
              label="App name (optional)"
              type="text"
              value={gitAppName}
              onChange={e => setGitAppName(e.target.value)}
              placeholder="Derived from repo name"
              disabled={status === 'deploying'}
            />
          </div>

          {/* Token + auto-redeploy row */}
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: 'var(--text-2)' }}>
              Authentication (private repos)
            </label>
            <div className="flex gap-2">
              <select
                value={selectedToken}
                onChange={e => setSelectedToken(e.target.value)}
                className={inlineFieldClass}
                disabled={status === 'deploying'}
              >
                <option value="">No token (public repo)</option>
                {tokens.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setShowTokenForm(!showTokenForm)}
                title="Manage tokens"
                aria-label="Manage tokens"
                className="dui-btn-secondary flex-shrink-0 rounded-lg border px-3 py-2 transition-colors"
              >
                <Key className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Token manager panel */}
          {showTokenForm && (
            <div
              className="space-y-3 rounded-lg border p-4"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            >
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>
                Manage tokens
              </h3>
              {tokens.length > 0 && (
                <div className="space-y-1.5">
                  {tokens.map(t => (
                    <div
                      key={t.id}
                      className="flex items-center justify-between rounded px-2 py-1.5"
                      style={{ background: 'var(--bg-3)', border: '1px solid var(--border)' }}
                    >
                      <span className="text-sm" style={{ color: 'var(--text-2)' }}>
                        {t.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteToken(t.id)}
                        title="Delete token"
                        aria-label="Delete token"
                        className="transition-colors hover:text-[var(--err)]"
                        style={{ color: 'var(--text-3)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTokenName}
                  onChange={e => setNewTokenName(e.target.value)}
                  placeholder="Label"
                  className={inlineFieldClass}
                />
                <input
                  type="password"
                  value={newTokenValue}
                  onChange={e => setNewTokenValue(e.target.value)}
                  placeholder="ghp_..."
                  className={inlineFieldClass}
                />
                <button
                  type="button"
                  onClick={handleAddToken}
                  disabled={!newTokenName.trim() || !newTokenValue.trim()}
                  title="Add token"
                  aria-label="Add token"
                  className="dui-btn-primary flex-shrink-0 rounded-lg border px-3 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                Use a fine-grained PAT with <code>Contents: Read</code> permission.
              </p>
            </div>
          )}

          {/* Options */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoRedeploy"
              checked={autoRedeploy}
              onChange={e => setAutoRedeploy(e.target.checked)}
              className="h-4 w-4 rounded"
              style={{ accentColor: 'var(--accent)' }}
              disabled={status === 'deploying'}
            />
            <label htmlFor="autoRedeploy" className="text-sm" style={{ color: 'var(--text-2)' }}>
              Auto-redeploy when code is pushed (via GitHub webhook)
            </label>
          </div>

          {/* Deploy button */}
          <Button
            onClick={handleGitDeploy}
            disabled={!repoUrl.trim()}
            loading={status === 'deploying'}
            className="w-full"
          >
            {status === 'deploying' ? (
              deployStep || 'Deploying...'
            ) : (
              <>
                Deploy from GitHub
                <ExternalLink className="h-4 w-4" />
              </>
            )}
          </Button>
        </Card>
      )}

      {/* Upload tab */}
      {tab === 'upload' && (
        <Card className="max-w-2xl space-y-5">
          {/* App name */}
          <Input
            label="Application name (optional)"
            type="text"
            value={uploadAppName}
            onChange={e => setUploadAppName(e.target.value)}
            placeholder="Auto-generated if empty"
            disabled={status === 'deploying'}
          />

          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => status !== 'deploying' && fileInputRef.current?.click()}
            className="cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors"
            style={{
              borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
              background: dragOver ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept=".js,.ts,.jsx,.tsx,.py,.go,.html,.css,.json,.yaml,.yml,.toml,.mod,.sum,.txt,.md,.env,.lock"
            />
            {status === 'deploying' ? (
              <>
                <Loader2
                  className="mx-auto mb-3 h-10 w-10 animate-spin"
                  style={{ color: 'var(--accent)' }}
                />
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Uploading and deploying...
                </p>
              </>
            ) : (
              <>
                <FolderUp className="mx-auto mb-3 h-10 w-10" style={{ color: 'var(--text-3)' }} />
                <p className="mb-1 text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Drag &amp; drop files here, or click to browse
                </p>
                <p className="text-xs" style={{ color: 'var(--text-2)' }}>
                  Upload your application files to deploy
                </p>
              </>
            )}
          </div>

          {/* CLI hint */}
          {filesystemHint && (
            <div
              className="rounded-lg border p-4"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
            >
              <p
                className="mb-2 text-xs font-medium uppercase tracking-wide"
                style={{ color: 'var(--text-3)' }}
              >
                Or deploy via filesystem
              </p>
              <div className="rounded-md px-3 py-2" style={{ background: '#0d1117' }}>
                <code
                  className="font-mono text-xs"
                  style={{
                    color: 'var(--ok)',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                  }}
                >
                  {filesystemHint}
                </code>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export default DeployPage;
