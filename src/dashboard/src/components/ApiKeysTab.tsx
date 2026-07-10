import { useState, useEffect, FormEvent } from 'react';
import { KeyRound, Copy, Trash2, Plus, CheckCircle, AlertTriangle } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  role: 'admin' | 'user' | 'readonly';
  createdAt: string;
  lastUsed?: string;
  expiresAt?: string;
}

interface CreatedApiKey {
  key: string;
  id: string;
  name: string;
  prefix: string;
  role: 'admin' | 'user' | 'readonly';
  createdAt: string;
  expiresAt?: string;
}

const RESERVED_NAME = 'cli-local';

const inputClass =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500';
const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

const roleBadgeClass: Record<ApiKeyRecord['role'], string> = {
  admin: 'bg-drop-100 dark:bg-drop-900/30 text-drop-700 dark:text-drop-400',
  user: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  readonly: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
};

const formatDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : 'Never');

function ApiKeysTab() {
  const { toast } = useToast();
  const confirmDialog = useConfirm();

  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [step, setStep] = useState<'idle' | 'form' | 'reveal'>('idle');
  const [name, setName] = useState('');
  const [role, setRole] = useState<ApiKeyRecord['role']>('readonly');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);

  const fetchKeys = async () => {
    setLoading(true);
    setError('');
    const json = await apiJson<ApiKeyRecord[]>('/auth/api-keys');
    if (json.success) {
      setKeys(json.data || []);
    } else {
      setError(json.error?.message || 'Failed to load API keys');
    }
    setLoading(false);
  };

  useEffect(() => { fetchKeys(); }, []);

  const resetForm = () => {
    setName('');
    setRole('readonly');
    setExpiresInDays('');
    setFormError('');
  };

  const handleStartCreate = () => {
    resetForm();
    setStep('form');
  };

  const handleCancelForm = () => {
    resetForm();
    setStep('idle');
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');

    const trimmedName = name.trim();
    if (!trimmedName) { setFormError('Name is required'); return; }
    if (trimmedName.length > 64) { setFormError('Name must be 64 characters or fewer'); return; }
    if (trimmedName === RESERVED_NAME) { setFormError(`"${RESERVED_NAME}" is reserved for the platform's local CLI key`); return; }

    let parsedExpiry: number | undefined;
    if (expiresInDays.trim() !== '') {
      const n = Number(expiresInDays);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        setFormError('Expires in days must be a whole number between 1 and 3650');
        return;
      }
      parsedExpiry = n;
    }

    setCreating(true);
    const json = await apiJson<CreatedApiKey>('/auth/api-keys', {
      method: 'POST',
      ...jsonBody({
        name: trimmedName,
        role,
        ...(parsedExpiry !== undefined ? { expiresInDays: parsedExpiry } : {}),
      }),
    });
    setCreating(false);

    if (json.success && json.data) {
      setCreatedKey(json.data);
      setStep('reveal');
    } else {
      toast('error', json.error?.message || 'Failed to create API key');
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      toast('success', 'Key copied to clipboard');
    } catch {
      toast('error', 'Could not copy automatically — select and copy the key manually');
    }
  };

  const handleDone = () => {
    setCreatedKey(null);
    resetForm();
    setStep('idle');
    fetchKeys();
  };

  const handleDelete = async (k: ApiKeyRecord) => {
    const isCliLocal = k.name === RESERVED_NAME;
    const confirmed = await confirmDialog({
      title: 'Delete API key',
      message: isCliLocal
        ? 'Deleting this will break local CLI authentication until the platform restarts.'
        : `Delete API key '${k.name}'? This cannot be undone.`,
      confirmText: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) return;

    const json = await apiJson<{ message: string }>(`/auth/api-keys/${k.id}`, { method: 'DELETE' });
    if (json.success) {
      toast('success', 'API key deleted');
      fetchKeys();
    } else {
      toast('error', json.error?.message || 'Failed to delete API key');
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-gray-500" />
          <h2 className="font-semibold text-gray-900 dark:text-white">API Keys</h2>
        </div>
        {step === 'idle' && (
          <button
            onClick={handleStartCreate}
            className="flex items-center gap-2 px-3 py-1.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create API key
          </button>
        )}
      </div>

      <div className="p-4">
        {step === 'form' && (
          <form onSubmit={handleCreate} className="mb-6 space-y-3 max-w-md bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            {formError && (
              <div role="alert" className="p-2.5 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
                {formError}
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="api-key-name">Name</label>
              <input
                id="api-key-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                placeholder="e.g. CI deploy key"
                autoFocus
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="api-key-role">Role</label>
              <select id="api-key-role" value={role} onChange={(e) => setRole(e.target.value as ApiKeyRecord['role'])} className={inputClass}>
                <option value="readonly">Readonly</option>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="api-key-expires">Expires in (days)</label>
              <input
                id="api-key-expires"
                type="number"
                min={1}
                max={3650}
                step={1}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="Never expires"
                className={inputClass}
              />
            </div>
            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={creating} className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium">
                {creating ? 'Creating...' : 'Create key'}
              </button>
              <button type="button" onClick={handleCancelForm} className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm">
                Cancel
              </button>
            </div>
          </form>
        )}

        {step === 'reveal' && createdKey && (
          <div className="mb-6 max-w-md bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <p className="text-sm font-medium">This key won't be shown again — copy it now.</p>
            </div>
            <code className="block text-xs font-mono bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 px-3 py-2 rounded border border-gray-200 dark:border-gray-700 break-all select-all">
              {createdKey.key}
            </code>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm font-medium"
              >
                <Copy className="w-4 h-4" />
                Copy
              </button>
              <button
                type="button"
                onClick={handleDone}
                className="flex items-center gap-2 px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 text-sm font-medium"
              >
                <CheckCircle className="w-4 h-4" />
                Done
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No API keys yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Prefix</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Role</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Created</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Last used</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 dark:text-gray-400">Expires</th>
                  <th className="text-right py-2 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {keys.map((k) => {
                  const isCliLocal = k.name === RESERVED_NAME;
                  const isExpired = !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
                  return (
                    <tr key={k.id}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-white">{k.name}</span>
                          {isCliLocal && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded font-medium uppercase">
                              System (CLI)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-gray-500 dark:text-gray-400">{k.prefix}</td>
                      <td className="py-2.5 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadgeClass[k.role]}`}>{k.role}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-gray-500 dark:text-gray-400 text-xs">{formatDate(k.createdAt)}</td>
                      <td className="py-2.5 pr-4 text-gray-500 dark:text-gray-400 text-xs">{formatDate(k.lastUsed)}</td>
                      <td className="py-2.5 pr-4 text-gray-500 dark:text-gray-400 text-xs">
                        <div className="flex items-center gap-1.5">
                          {formatDate(k.expiresAt)}
                          {isExpired && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded font-medium uppercase">
                              Expired
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => handleDelete(k)}
                          className="text-gray-400 hover:text-red-500 transition-colors"
                          title="Delete API key"
                          aria-label={`Delete API key ${k.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default ApiKeysTab;
