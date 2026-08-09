import { useState, useRef, useEffect, DragEvent, InputHTMLAttributes } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import {
  gitDeploy,
  getGitTokens,
  addGitToken,
  deleteGitToken,
  GitTokenInfo,
  App,
  useHealth,
} from '../hooks/useApi';
import { appLinkInfo } from '../api/client';
import Tabs, { TabDef } from '../components/Tabs';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import { buildArchiveFromFiles, UploadArchiveError } from '../lib/upload-archive';
import { APP_NAME_RE, commonRootName, normalizeEntryPath } from '../../../utils/upload-paths';
import { formatBytes } from '../components/db-format';

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
  const { role } = useAuth();

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
  const [uploadFileCount, setUploadFileCount] = useState(0);
  const [uploadBytes, setUploadBytes] = useState(0);
  const [uploadSkipped, setUploadSkipped] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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
    setUploadFileCount(0);
    setUploadBytes(0);
    setUploadSkipped([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
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

    // A dropped FOLDER still appears in `dataTransfer.files`, as a single
    // zero-byte pseudo-file whose `arrayBuffer()` rejects with an opaque
    // NotReadableError. Recursive directory reading (webkitGetAsEntry
    // traversal) is deliberately out of scope, so detect the case and say
    // what to do instead of surfacing a raw DOM error for the gesture this
    // product is named after. Read synchronously: the item list is neutered
    // once the handler yields.
    const items = e.dataTransfer.items;
    for (let i = 0; i < (items?.length ?? 0); i++) {
      if (items[i].webkitGetAsEntry?.()?.isDirectory) {
        setStatus('error');
        setMessage(
          "Dropping a folder isn't supported yet — click the drop zone to choose your app's folder instead."
        );
        return;
      }
    }

    if (e.dataTransfer.files.length > 0) await uploadFiles(e.dataTransfer.files);
  };

  const handleFileSelect = async () => {
    const input = fileInputRef.current;
    const files = input?.files;
    if (!files || files.length === 0) return;
    try {
      await uploadFiles(files);
    } finally {
      // Clear so re-picking the SAME file(s) fires `change` again — e.g.
      // after cancelling the "replace existing app" confirmation below.
      if (input) input.value = '';
    }
  };

  const handleFolderSelect = async () => {
    const input = folderInputRef.current;
    const files = input?.files;
    if (!files || files.length === 0) return;
    try {
      await uploadFiles(files);
    } finally {
      if (input) input.value = '';
    }
  };

  /**
   * Best-effort app name from the selection's shared root directory — the
   * same "shared first segment" rule `stripCommonRoot` applies to entry
   * paths (`upload-archive.ts` applies it again, independently, while
   * actually building the archive). Computed here, cheaply and with no
   * bytes read, so a name is available before the pre-flight check below —
   * which must run before the possibly-large archive is built.
   */
  const deriveRootDirectoryName = (files: ArrayLike<File>): string | null => {
    const normalized: string[] = [];
    for (let i = 0; i < files.length; i++) {
      try {
        normalized.push(normalizeEntryPath(files[i].webkitRelativePath || files[i].name));
      } catch {
        // A path the archive builder will reject anyway — let it report the
        // real reason rather than failing here with a name-derivation error.
        return null;
      }
    }
    // Shared with stripCommonRoot, so the name shown here and the root the
    // uploaded paths actually lose can never disagree.
    return commonRootName(normalized);
  };

  /** Maps a failed `/:name/source` response to a message worth showing —
   * the server's own `error.message` names the specific reason (e.g. a 409
   * naming `git/redeploy`, or a 400 naming `vcs_metadata`/`invalid_archive`),
   * so it's always preferred over a generic fallback. */
  const uploadErrorMessage = (status: number, json: { error?: { message?: string } }): string => {
    if (json?.error?.message) return json.error.message;
    if (status === 413) return "Upload exceeds the server's size limit (100 MB compressed).";
    if (status === 429) return 'Too many uploads recently — wait a moment and try again.';
    return `Upload failed (${status})`;
  };

  // Poll app status until running or errored — mirrors handleGitDeploy's poll
  // loop above. A 202 from /:name/source means "accepted", not "finished":
  // the archive still has to extract, build and start.
  const pollUploadedApp = (appName: string) => {
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
  };

  const uploadFiles = async (files: FileList) => {
    // Re-entrancy guard. The drop zone's onClick is gated on this, but a DROP
    // is not, and the tabs share `status`/`deployStep`/`deployedApp` — so a
    // second selection (or a switch to this tab mid-git-deploy) could start a
    // parallel run. Two consequences, both worse than a no-op: the two poll
    // loops race to write the same state, and `ConfirmProvider` holds exactly
    // one pending resolve, so a second confirmDialog() overwrites the first —
    // whose `await` then never settles at all.
    if (status === 'deploying') return;
    if (files.length === 0) return;

    // Snapshot the FileList. It comes from a live `DataTransfer` on the drop
    // path, and the two awaits below (pre-flight, confirmation) yield the
    // event loop before the bytes are read.
    const picked = Array.from(files);

    // /:name/source takes the app name from the URL path — unlike git
    // deploy, there is no server-side auto-generation to fall back on.
    const name = uploadAppName.trim() || deriveRootDirectoryName(picked) || '';
    if (!name) {
      setStatus('error');
      setMessage('Enter an application name, or select a folder — its name is used.');
      return;
    }
    if (!APP_NAME_RE.test(name)) {
      setStatus('error');
      setMessage(
        `"${name}" isn't a valid app name — use 1-64 letters, digits, hyphens or underscores, starting with a letter or digit.`
      );
      return;
    }

    setStatus('deploying');
    setMessage('');
    setUploadFileCount(0);
    setUploadBytes(0);
    setUploadSkipped([]);
    setDeployStep('Checking for an existing app...');

    try {
      // Pre-flight: does an app by this name already exist? Does double
      // duty — refuses (client-side, before spending a build) an upload
      // that would sever a git-deployed app's link, and requires
      // confirmation before an upload that would otherwise silently prune
      // an existing app's files to match the new archive.
      const existingRes = await fetch(`/api/v1/apps/${name}`, { headers: getAuthHeaders() });
      if (existingRes.status === 200) {
        const existingJson = await existingRes.json();
        const existingApp = existingJson?.data as App | undefined;
        // `groupGitBacked` covers a monorepo child, which carries no
        // `gitSource` of its own (the hidden group container holds it) —
        // without this, uploading over a child pays the full tar+gzip
        // before the server's 409 tells us the same thing.
        if (existingApp?.gitSource || existingApp?.groupGitBacked) {
          setStatus('error');
          setMessage(
            `"${name}" is deployed from git; uploading would sever the git link. Redeploy from the GitHub tab instead, or delete the app first to switch to uploads.`
          );
          return;
        }
        const confirmed = await confirmDialog({
          title: `Replace "${name}"?`,
          message: `An app named "${name}" already exists. Uploading will replace its files with your selection — anything not included will be deleted.`,
          confirmText: `Replace ${name}`,
          variant: 'danger',
        });
        if (!confirmed) {
          setStatus('idle');
          return;
        }
      } else if (existingRes.status !== 404) {
        const json = await existingRes.json().catch(() => ({}));
        setStatus('error');
        setMessage(json?.error?.message || `Couldn't check for an existing app (${existingRes.status}).`);
        return;
      }

      setDeployStep('Building archive...');
      const archive = await buildArchiveFromFiles(picked);
      setUploadFileCount(archive.fileCount);
      setUploadBytes(archive.bytes);
      setUploadSkipped(archive.skipped);

      setDeployStep('Uploading...');
      const res = await fetch(`/api/v1/apps/${name}/source`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/gzip' },
        body: archive.blob,
      });
      const json = await res.json();

      // 202 body is { app, acceptedAt, isNew } — `app` is the app NAME
      // (a string), not a DTO (UploadDeployResult in
      // upload-deploy.types.ts).
      if (res.status === 202 && json.success && json.data?.app) {
        const appName = json.data.app as string;
        setDeployedApp(appName);
        setDeployStep('Building application...');
        pollUploadedApp(appName);
        return;
      }

      setStatus('error');
      setMessage(uploadErrorMessage(res.status, json));
    } catch (err) {
      setStatus('error');
      setMessage(
        err instanceof UploadArchiveError || err instanceof Error ? err.message : 'Network error'
      );
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
            {/* Clear the upload-derived display state too, not just the
                status. `uploadFiles` resets these only just before the
                pre-flight, so a failure AFTER the archive was built (409, 413,
                429) leaves them populated — and the skipped-paths panel would
                then show the abandoned attempt's file count and skip list on
                the idle form, as though it described the next upload. The git
                fields are deliberately preserved: those are inputs to correct
                and resubmit, whereas these are outputs of one specific run. */}
            <Button
              variant="primary"
              onClick={() => {
                setStatus('idle');
                setUploadFileCount(0);
                setUploadBytes(0);
                setUploadSkipped([]);
              }}
            >
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
          <p className="-mt-2 text-xs" style={{ color: 'var(--text-3)' }}>
            {/* The Git webhooks settings tab is admin-only — don't deep-link
                non-admins to a tab they can't open (SettingsPage would
                silently fall back to the Account tab). */}
            {role === 'admin' ? (
              <>
                Requires a webhook secret — configure one in{' '}
                <Link to="/settings?tab=git-webhooks" className="underline">
                  Settings &rarr; Git webhooks
                </Link>
                .
              </>
            ) : (
              <>Requires a webhook secret — ask an admin to configure one in Settings.</>
            )}
          </p>

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
            label="Application name"
            type="text"
            value={uploadAppName}
            onChange={e => setUploadAppName(e.target.value)}
            placeholder="Uses the selected folder's name if left blank"
            disabled={status === 'deploying'}
          />

          {/* Drop zone — click opens a folder picker (webkitdirectory), since
              a whole app folder is the expected input; the loose-file
              fallback below covers a plain multi-file selection. */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => status !== 'deploying' && folderInputRef.current?.click()}
            className="cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors"
            style={{
              borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
              background: dragOver ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <input
              ref={folderInputRef}
              type="file"
              multiple
              onChange={handleFolderSelect}
              className="hidden"
              {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
            />
            {status === 'deploying' ? (
              <>
                <Loader2
                  className="mx-auto mb-3 h-10 w-10 animate-spin"
                  style={{ color: 'var(--accent)' }}
                />
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {deployStep || 'Uploading and deploying...'}
                </p>
                {(uploadFileCount > 0 || uploadSkipped.length > 0) && (
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-2)' }}>
                    {uploadFileCount} file{uploadFileCount === 1 ? '' : 's'}, {formatBytes(uploadBytes)} compressed
                  </p>
                )}
              </>
            ) : (
              <>
                <FolderUp className="mx-auto mb-3 h-10 w-10" style={{ color: 'var(--text-3)' }} />
                <p className="mb-1 text-sm font-medium" style={{ color: 'var(--text)' }}>
                  Click to choose your app's folder, or drag &amp; drop files here
                </p>
                <p className="text-xs" style={{ color: 'var(--text-2)' }}>
                  A folder is expected — <code>.git</code> and <code>node_modules</code> are excluded
                  automatically.
                </p>
              </>
            )}
          </div>

          {/* Skipped-paths list — shown while/after building the archive so
              the user can see what a folder drop excluded (.git is a hard
              server-side rejection, not just hygiene, so this must be
              visible rather than a silent difference). */}
          {uploadSkipped.length > 0 && (
            <div
              className="rounded-lg border p-3 text-xs"
              style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--text-3)' }}
            >
              <p className="mb-1 font-medium" style={{ color: 'var(--text-2)' }}>
                Skipped {uploadSkipped.length} path{uploadSkipped.length === 1 ? '' : 's'} (.git, node_modules)
              </p>
              <ul className="space-y-0.5 font-mono">
                {uploadSkipped.slice(0, 5).map(p => (
                  <li key={p} className="truncate">
                    {p}
                  </li>
                ))}
                {uploadSkipped.length > 5 && <li>+{uploadSkipped.length - 5} more</li>}
              </ul>
            </div>
          )}

          {/* Loose-file fallback */}
          {status !== 'deploying' && (
            <p className="-mt-3 text-center text-xs" style={{ color: 'var(--text-3)' }}>
              Not a folder?{' '}
              <button type="button" onClick={() => fileInputRef.current?.click()} className="underline">
                Select individual files instead
              </button>
              <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" />
            </p>
          )}

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
