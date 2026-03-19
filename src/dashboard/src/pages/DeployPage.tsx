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
import { getAuthHeaders } from '../hooks/useAuth';
import { gitDeploy, getGitTokens, addGitToken, deleteGitToken, GitTokenInfo } from '../hooks/useApi';

type Tab = 'github' | 'upload';
type DeployStatus = 'idle' | 'deploying' | 'success' | 'error';

const inputClass =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none text-sm';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

function DeployPage() {
  const [tab, setTab] = useState<Tab>('github');
  const { toast } = useToast();
  const navigate = useNavigate();

  // Shared result state
  const [status, setStatus] = useState<DeployStatus>('idle');
  const [message, setMessage] = useState('');
  const [deployedApp, setDeployedApp] = useState('');

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

    const result = await gitDeploy({
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      name: gitAppName.trim() || undefined,
      autoRedeploy,
      tokenId: selectedToken || undefined,
    });

    if (result.success && result.data) {
      setStatus('success');
      setDeployedApp(result.data.appName);
      setMessage(`${result.data.appName} is being cloned, built, and started from ${result.data.repoUrl} (${result.data.branch})`);
      toast('success', `Deploying ${result.data.appName}`);
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
    if (!confirm('Delete this token?')) return;
    const deleted = await deleteGitToken(id);
    if (deleted) {
      setTokens(tokens.filter((t) => t.id !== id));
      if (selectedToken === id) setSelectedToken('');
      toast('success', 'Token deleted');
    }
  };

  // --- File Upload ---
  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); setDragOver(false); };

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
        <div className="max-w-lg mx-auto mt-12">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center">
            <div className="w-14 h-14 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-5">
              <CheckCircle className="w-7 h-7 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Deployment started
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
              {message}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              {deployedApp && (
                <button
                  onClick={() => navigate(`/apps/${deployedApp}`)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 font-medium text-sm transition-colors"
                >
                  View application
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={resetState}
                className="inline-flex items-center justify-center px-5 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 font-medium text-sm transition-colors"
              >
                Deploy another
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="p-6">
        <div className="max-w-lg mx-auto mt-12">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-red-200 dark:border-red-800/50 p-8 text-center">
            <div className="w-14 h-14 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-5">
              <AlertCircle className="w-7 h-7 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Deployment failed
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed">
              {message}
            </p>
            <button
              onClick={() => setStatus('idle')}
              className="inline-flex items-center justify-center px-5 py-2.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 font-medium text-sm transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deploy</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Deploy a new application from GitHub or by uploading files
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 mb-6 max-w-2xl">
        <button
          onClick={() => setTab('github')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === 'github'
              ? 'border-drop-600 text-drop-600 dark:text-drop-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <GitBranch className="w-4 h-4" />
          GitHub
        </button>
        <button
          onClick={() => setTab('upload')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
            tab === 'upload'
              ? 'border-drop-600 text-drop-600 dark:text-drop-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <FolderUp className="w-4 h-4" />
          Upload
        </button>
      </div>

      {/* GitHub tab */}
      {tab === 'github' && (
        <div className="max-w-2xl space-y-5">
          {/* Repo URL */}
          <div>
            <label className={labelClass}>Repository URL</label>
            <div className="relative">
              <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                className={`${inputClass} pl-10`}
                disabled={status === 'deploying'}
              />
            </div>
          </div>

          {/* Branch + Name row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Branch</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className={inputClass}
                disabled={status === 'deploying'}
              />
            </div>
            <div>
              <label className={labelClass}>App name (optional)</label>
              <input
                type="text"
                value={gitAppName}
                onChange={(e) => setGitAppName(e.target.value)}
                placeholder="Derived from repo name"
                className={inputClass}
                disabled={status === 'deploying'}
              />
            </div>
          </div>

          {/* Token + auto-redeploy row */}
          <div>
            <label className={labelClass}>Authentication (private repos)</label>
            <div className="flex gap-2">
              <select
                value={selectedToken}
                onChange={(e) => setSelectedToken(e.target.value)}
                className={inputClass}
                disabled={status === 'deploying'}
              >
                <option value="">No token (public repo)</option>
                {tokens.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                onClick={() => setShowTokenForm(!showTokenForm)}
                className="flex-shrink-0 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
                title="Manage tokens"
              >
                <Key className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Token manager panel */}
          {showTokenForm && (
            <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Manage tokens</h3>
              {tokens.length > 0 && (
                <div className="space-y-1.5">
                  {tokens.map((t) => (
                    <div key={t.id} className="flex items-center justify-between py-1.5 px-2 rounded bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                      <span className="text-sm text-gray-700 dark:text-gray-300">{t.name}</span>
                      <button onClick={() => handleDeleteToken(t.id)} className="text-gray-400 hover:text-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input type="text" value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} placeholder="Label" className={inputClass} />
                <input type="password" value={newTokenValue} onChange={(e) => setNewTokenValue(e.target.value)} placeholder="ghp_..." className={inputClass} />
                <button onClick={handleAddToken} disabled={!newTokenName.trim() || !newTokenValue.trim()} className="flex-shrink-0 px-3 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 transition-colors">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Use a fine-grained PAT with <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">Contents: Read</code> permission.
              </p>
            </div>
          )}

          {/* Options */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoRedeploy"
              checked={autoRedeploy}
              onChange={(e) => setAutoRedeploy(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-drop-600 focus:ring-drop-500"
              disabled={status === 'deploying'}
            />
            <label htmlFor="autoRedeploy" className="text-sm text-gray-600 dark:text-gray-400">
              Auto-redeploy when code is pushed (via GitHub webhook)
            </label>
          </div>

          {/* Deploy button */}
          <button
            onClick={handleGitDeploy}
            disabled={!repoUrl.trim() || status === 'deploying'}
            className="w-full px-4 py-3 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-colors"
          >
            {status === 'deploying' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Cloning repository...
              </>
            ) : (
              <>
                Deploy from GitHub
                <ExternalLink className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      )}

      {/* Upload tab */}
      {tab === 'upload' && (
        <div className="max-w-2xl space-y-5">
          {/* App name */}
          <div>
            <label className={labelClass}>Application name (optional)</label>
            <input
              type="text"
              value={uploadAppName}
              onChange={(e) => setUploadAppName(e.target.value)}
              placeholder="Auto-generated if empty"
              className={inputClass}
              disabled={status === 'deploying'}
            />
          </div>

          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => status !== 'deploying' && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
              dragOver
                ? 'border-drop-500 bg-drop-50 dark:bg-drop-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-drop-400 hover:bg-gray-50 dark:hover:bg-gray-800/50'
            }`}
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
                <Loader2 className="w-10 h-10 text-drop-500 mx-auto mb-3 animate-spin" />
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Uploading and deploying...</p>
              </>
            ) : (
              <>
                <FolderUp className="w-10 h-10 text-gray-400 dark:text-gray-500 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Drag & drop files here, or click to browse
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Upload your application files to deploy
                </p>
              </>
            )}
          </div>

          {/* CLI hint */}
          <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
              Or deploy via filesystem
            </p>
            <div className="bg-gray-900 dark:bg-gray-950 rounded-md px-3 py-2">
              <code className="text-xs text-green-400 font-mono">
                {navigator.platform.includes('Win')
                  ? 'copy my-app\\ C:\\drop\\data\\webapps\\my-app\\'
                  : 'cp -r ./my-app /var/drop/data/webapps/'}
              </code>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DeployPage;
