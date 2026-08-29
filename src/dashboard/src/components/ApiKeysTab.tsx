import { useState, useEffect, FormEvent } from 'react';
import { KeyRound, Copy, Trash2, Plus, CheckCircle, AlertTriangle } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { asArray } from '../lib/api-shape';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import Button from './ui/Button';
import Input from './ui/Input';
import Card from './ui/Card';
import Field from './ui/Field';
import { SkeletonText } from './ui/Skeleton';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from './ui/Table';

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

// Token-driven role tones (styles/app-ui.css `.dui-badge-*`). admin keeps the
// brand/accent tone (its original highlighted styling); user and readonly
// stay distinguishable via ok/neutral.
const roleBadgeTone: Record<ApiKeyRecord['role'], string> = {
  admin: 'dui-badge-accent',
  user: 'dui-badge-ok',
  readonly: 'dui-badge-neutral',
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
      setKeys(asArray<ApiKeyRecord>(json.data));
    } else {
      setError(json.error?.message || 'Failed to load API keys');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchKeys();
  }, []);

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
    if (!trimmedName) {
      setFormError('Name is required');
      return;
    }
    if (trimmedName.length > 64) {
      setFormError('Name must be 64 characters or fewer');
      return;
    }
    if (trimmedName === RESERVED_NAME) {
      setFormError(`"${RESERVED_NAME}" is reserved for the platform's local CLI key`);
      return;
    }

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
    <Card padded={false} className="mb-6">
      <div
        className="px-4 py-3 border-b flex items-center justify-between border-line"
      >
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-muted" />
          <h2 className="font-semibold text-fg">
            API Keys
          </h2>
        </div>
        {step === 'idle' && (
          <Button onClick={handleStartCreate} className="text-sm">
            <Plus className="w-4 h-4" />
            Create API key
          </Button>
        )}
      </div>

      <div className="p-4">
        {step === 'form' && (
          <form
            onSubmit={handleCreate}
            className="mb-6 space-y-3 max-w-md border rounded-lg p-4 bg-surface-2 border-line"
          >
            {formError && (
              <div
                role="alert"
                className="p-2.5 border rounded-lg text-sm"
                style={{
                  background: 'color-mix(in srgb, var(--err) 15%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
                  color: 'var(--err)',
                }}
              >
                {formError}
              </div>
            )}
            <Input
              id="api-key-name"
              label="Name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={64}
              placeholder="e.g. CI deploy key"
              autoFocus
            />
            <Field label="Role" id="api-key-role">
              {({ id }) => (
                <select
                  id={id}
                  value={role}
                  onChange={e => setRole(e.target.value as ApiKeyRecord['role'])}
                  className="dui-input w-full rounded-lg px-3 py-2 text-sm outline-none"
                >
                  <option value="readonly">Readonly</option>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              )}
            </Field>
            <Input
              id="api-key-expires"
              label="Expires in (days)"
              type="number"
              min={1}
              max={3650}
              step={1}
              value={expiresInDays}
              onChange={e => setExpiresInDays(e.target.value)}
              placeholder="Never expires"
            />
            <div className="flex gap-3 pt-1">
              <Button type="submit" loading={creating}>
                {creating ? 'Creating...' : 'Create key'}
              </Button>
              <Button type="button" variant="secondary" onClick={handleCancelForm}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step === 'reveal' && createdKey && (
          <div
            className="mb-6 max-w-md border rounded-lg p-4 space-y-3 bg-surface-2 border-line"
          >
            <div className="flex items-center gap-2 text-warn">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <p className="text-sm font-medium">This key won't be shown again — copy it now.</p>
            </div>
            <code
              className="block text-xs font-mono px-3 py-2 rounded border break-all select-all bg-surface-3 text-fg border-line"
            >
              {createdKey.key}
            </code>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={handleCopy}>
                <Copy className="w-4 h-4" />
                Copy
              </Button>
              <Button type="button" onClick={handleDone}>
                <CheckCircle className="w-4 h-4" />
                Done
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <SkeletonText label="Loading API keys" />
        ) : error ? (
          <p className="text-sm text-err">
            {error}
          </p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted">
            No API keys yet
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table density="compact">
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Prefix</TableHeaderCell>
                  <TableHeaderCell>Role</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Last used</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell align="right" className="pr-0">
                    Actions
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {keys.map(k => {
                  const isCliLocal = k.name === RESERVED_NAME;
                  const isExpired = !!k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
                  return (
                    <TableRow key={k.id} className="last:border-b-0">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-fg">{k.name}</span>
                          {isCliLocal && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase dui-badge-neutral">
                              System (CLI)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-faint">{k.prefix}</TableCell>
                      <TableCell>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadgeTone[k.role]}`}
                        >
                          {k.role}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-faint">{formatDate(k.createdAt)}</TableCell>
                      <TableCell className="text-xs text-faint">{formatDate(k.lastUsed)}</TableCell>
                      <TableCell className="text-xs text-faint">
                        <div className="flex items-center gap-1.5">
                          {formatDate(k.expiresAt)}
                          {isExpired && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase dui-badge-err">
                              Expired
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell align="right" className="pr-0">
                        <button
                          onClick={() => handleDelete(k)}
                          className="dui-focus-ring rounded text-faint transition-colors hover:text-err focus-visible:outline-none"
                          title="Delete API key"
                          aria-label={`Delete API key ${k.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Card>
  );
}

export default ApiKeysTab;
