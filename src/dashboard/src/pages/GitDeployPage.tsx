import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Loader2, CheckCircle, AlertCircle, Key, Trash2, Plus } from 'lucide-react';
import { useToast } from '../components/Toast';
import { gitDeploy, getGitTokens, addGitToken, deleteGitToken, GitTokenInfo } from '../hooks/useApi';

function GitDeployPage() {
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [appName, setAppName] = useState('');
  const [autoRedeploy, setAutoRedeploy] = useState(true);
  const [selectedToken, setSelectedToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'deploying' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [deployedApp, setDeployedApp] = useState('');

  // Token management
  const [tokens, setTokens] = useState<GitTokenInfo[]>([]);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenValue, setNewTokenValue] = useState('');

  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    getGitTokens().then(setTokens);
  }, []);

  const handleDeploy = async () => {
    if (!repoUrl.trim()) return;

    setStatus('deploying');
    setMessage('');

    const result = await gitDeploy({
      repoUrl: repoUrl.trim(),
      branch: branch.trim() || 'main',
      name: appName.trim() || undefined,
      autoRedeploy,
      tokenId: selectedToken || undefined,
    });

    if (result.success && result.data) {
      setStatus('success');
      setMessage(`Deployed ${result.data.appName} from ${result.data.repoUrl}`);
      setDeployedApp(result.data.appName);
      toast('success', `Deploying ${result.data.appName}...`);
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

  const resetState = () => {
    setStatus('idle');
    setMessage('');
    setRepoUrl('');
    setAppName('');
    setBranch('main');
    setDeployedApp('');
  };

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Deploy from GitHub</h1>
        <p className="text-gray-500 dark:text-gray-400">
          Paste a GitHub repository URL to deploy
        </p>
      </div>

      {status === 'success' ? (
        <div className="max-w-lg text-center py-12">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <p className="text-lg font-medium text-green-700 dark:text-green-400 mb-2">
            Deploying!
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{message}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => navigate(`/apps/${deployedApp}`)}
              className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700"
            >
              View App
            </button>
            <button
              onClick={resetState}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Deploy another
            </button>
          </div>
        </div>
      ) : status === 'error' ? (
        <div className="max-w-lg text-center py-12">
          <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
          <p className="text-lg font-medium text-red-700 dark:text-red-400 mb-2">Deploy failed</p>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">{message}</p>
          <button
            onClick={() => setStatus('idle')}
            className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="max-w-lg space-y-4">
          {/* Repo URL */}
          <div>
            <label className={labelClass}>Repository URL *</label>
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

          {/* Branch */}
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

          {/* App name */}
          <div>
            <label className={labelClass}>Application Name (optional)</label>
            <input
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              placeholder="Auto-detected from repo name"
              className={inputClass}
              disabled={status === 'deploying'}
            />
          </div>

          {/* Token selector */}
          <div>
            <label className={labelClass}>GitHub Token (for private repos)</label>
            <div className="flex gap-2">
              <select
                value={selectedToken}
                onChange={(e) => setSelectedToken(e.target.value)}
                className={inputClass}
                disabled={status === 'deploying'}
              >
                <option value="">None (public repo)</option>
                {tokens.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowTokenForm(!showTokenForm)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400"
                title="Manage tokens"
              >
                <Key className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Token management */}
          {showTokenForm && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                GitHub Tokens
              </h3>

              {/* Existing tokens */}
              {tokens.length > 0 && (
                <div className="space-y-2">
                  {tokens.map((t) => (
                    <div key={t.id} className="flex items-center justify-between text-sm">
                      <span className="text-gray-600 dark:text-gray-400">{t.name}</span>
                      <button
                        onClick={() => handleDeleteToken(t.id)}
                        className="text-red-400 hover:text-red-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add new token */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTokenName}
                  onChange={(e) => setNewTokenName(e.target.value)}
                  placeholder="Token name"
                  className={`${inputClass} text-sm`}
                />
                <input
                  type="password"
                  value={newTokenValue}
                  onChange={(e) => setNewTokenValue(e.target.value)}
                  placeholder="ghp_..."
                  className={`${inputClass} text-sm`}
                />
                <button
                  onClick={handleAddToken}
                  className="px-3 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 text-sm whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Use a Personal Access Token with <code>repo</code> scope for private repos.
              </p>
            </div>
          )}

          {/* Auto-redeploy toggle */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoRedeploy"
              checked={autoRedeploy}
              onChange={(e) => setAutoRedeploy(e.target.checked)}
              className="rounded border-gray-300 text-drop-600 focus:ring-drop-500"
              disabled={status === 'deploying'}
            />
            <label htmlFor="autoRedeploy" className="text-sm text-gray-700 dark:text-gray-300">
              Auto-redeploy on push (via webhook)
            </label>
          </div>

          {/* Deploy button */}
          <button
            onClick={handleDeploy}
            disabled={!repoUrl.trim() || status === 'deploying'}
            className="w-full px-4 py-3 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center justify-center gap-2"
          >
            {status === 'deploying' ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Cloning & deploying...
              </>
            ) : (
              'Deploy'
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export default GitDeployPage;
