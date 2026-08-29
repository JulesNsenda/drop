import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, Shield, ShieldOff, RefreshCw, ArrowLeft } from 'lucide-react';
import { getAuthHeaders } from '../hooks/useAuth';
import { asArray } from '../lib/api-shape';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import { App } from '../hooks/useApi';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from '../components/ui/Table';
import { cn } from '../lib/cn';
import StatCard from '../components/ui/StatCard';

interface UserInfo {
  id: string;
  username: string;
  email?: string;
  role: string;
  enabled: boolean;
  appCount: number;
  maxApps?: number;
  createdAt: string;
  lastLogin?: string;
}

interface ActivityEntry {
  id: string;
  action: string;
  username?: string;
  appName?: string;
  timestamp: string;
}

function UsersPage() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);
  const [userApps, setUserApps] = useState<App[]>([]);
  const [userActivity, setUserActivity] = useState<ActivityEntry[]>([]);
  const [resetPw, setResetPw] = useState('');
  const { toast } = useToast();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/users', { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) setUsers(asArray<UserInfo>(json.data));
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const selectUser = async (user: UserInfo) => {
    setSelectedUser(user);

    // Fetch all apps and filter by userId
    try {
      const res = await fetch('/api/v1/apps', { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) {
        setUserApps(asArray<App>(json.data).filter(a => a.userId === user.id));
      }
    } catch {
      setUserApps([]);
    }

    // Fetch activity filtered by username
    try {
      const res = await fetch('/api/v1/admin/activity?limit=50', { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) {
        setUserActivity(
          asArray<ActivityEntry>(json.data)
            .filter(a => a.username === user.username)
            .slice(0, 15)
        );
      }
    } catch {
      setUserActivity([]);
    }
  };

  const toggleUser = async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/v1/auth/users/${id}`, {
      method: 'PUT',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const json = await res.json();
    if (json.success) {
      toast('success', enabled ? 'User enabled' : 'User disabled');
      fetchUsers();
      if (selectedUser?.id === id) setSelectedUser({ ...selectedUser, enabled });
    } else {
      toast('error', json.error?.message || 'Failed');
    }
  };

  const formatDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : 'Never');
  const formatTime = (d: string) => new Date(d).toLocaleString();

  // User detail view
  if (selectedUser) {
    return (
      <div className="p-6">
        <button
          onClick={() => setSelectedUser(null)}
          className="mb-6 inline-flex items-center gap-2 text-sm transition-colors hover:text-[var(--accent)] text-muted"
        >
          <ArrowLeft className="h-4 w-4" /> Back to users
        </button>

        {/* User header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-fg">
              {selectedUser.username}
            </h1>
            {selectedUser.email && (
              <p className="text-sm text-muted">
                {selectedUser.email}
              </p>
            )}
            <div className="mt-1 flex items-center gap-3">
              <Badge tone={selectedUser.role === 'admin' ? 'accent' : 'neutral'}>
                {selectedUser.role}
              </Badge>
              <span
                className="text-xs"
                style={{ color: selectedUser.enabled ? 'var(--ok)' : 'var(--err)' }}
              >
                {selectedUser.enabled ? 'Active' : 'Disabled'}
              </span>
              <span className="text-xs text-faint">
                Joined {formatDate(selectedUser.createdAt)}
              </span>
            </div>
          </div>
          {selectedUser.role !== 'admin' && (
            <Button
              variant={selectedUser.enabled ? 'danger' : 'primary'}
              onClick={() => toggleUser(selectedUser.id, !selectedUser.enabled)}
            >
              {selectedUser.enabled ? (
                <>
                  <ShieldOff className="h-4 w-4" /> Disable
                </>
              ) : (
                <>
                  <Shield className="h-4 w-4" /> Enable
                </>
              )}
            </Button>
          )}
        </div>

        {/* Stats */}
        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <StatCard label="Applications" value={userApps.length} />
          <Card>
            <p className="mb-1 text-sm font-medium text-muted">
              App Limit
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={selectedUser.maxApps || 0}
                onChange={e =>
                  setSelectedUser({ ...selectedUser, maxApps: parseInt(e.target.value) || 0 })
                }
                className="dui-input w-16 rounded px-2 py-1 text-sm outline-none transition-colors"
              />
              <button
                onClick={async () => {
                  await fetch(`/api/v1/auth/users/${selectedUser.id}`, {
                    method: 'PUT',
                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ maxApps: selectedUser.maxApps || 0 }),
                  });
                  toast('success', 'App limit updated');
                }}
                className="text-xs font-medium text-accent"
              >
                Save
              </button>
            </div>
            <p className="mt-1 text-[10px] text-faint">
              0 = use global default
            </p>
          </Card>
          <StatCard label="Last Login" value={formatDate(selectedUser.lastLogin)} />
          <StatCard label="Recent Actions" value={userActivity.length} />
        </div>

        {/* User's apps */}
        <Card padded={false} className="mb-6">
          <div className="border-b px-4 py-3 border-line">
            <h2 className="font-semibold text-fg">
              Applications
            </h2>
          </div>
          {userApps.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              No applications deployed
            </div>
          ) : (
            <div className="divide-y border-line">
              {userApps.map(app => (
                <Link
                  key={app.name}
                  to={`/apps/${app.name}`}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-[var(--bg-2)] border-line"
                >
                  <div>
                    <span className="text-sm font-medium text-fg">
                      {app.name}
                    </span>
                    <span className="ml-2 text-xs text-faint">
                      {app.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {app.port && (
                      <span className="font-mono text-xs text-faint">
                        :{app.port}
                      </span>
                    )}
                    <StatusBadge status={app.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* Reset password (admin action) */}
        {selectedUser.role !== 'admin' && (
          <Card padded={false} className="mb-6">
            <div className="border-b px-4 py-3 border-line">
              <h2 className="font-semibold text-fg">
                Reset Password
              </h2>
            </div>
            <div className="flex max-w-md gap-2 p-4">
              <input
                type="password"
                value={resetPw}
                onChange={e => setResetPw(e.target.value)}
                placeholder="New password (min 8 chars)"
                minLength={8}
                className="dui-input flex-1 rounded-lg px-3 py-2 text-sm outline-none transition-colors"
              />
              <Button
                disabled={resetPw.length < 8}
                onClick={async () => {
                  if (resetPw.length < 8) {
                    toast('error', 'Min 8 characters');
                    return;
                  }
                  const res = await fetch(`/api/v1/auth/users/${selectedUser.id}/reset-password`, {
                    method: 'POST',
                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newPassword: resetPw }),
                  });
                  const json = await res.json();
                  if (json.success) {
                    toast('success', 'Password reset');
                    setResetPw('');
                  } else toast('error', json.error?.message || 'Failed');
                }}
              >
                Reset
              </Button>
            </div>
          </Card>
        )}

        {/* User's activity */}
        <Card padded={false}>
          <div className="border-b px-4 py-3 border-line">
            <h2 className="font-semibold text-fg">
              Recent Activity
            </h2>
          </div>
          {userActivity.length === 0 ? (
            <div className="p-4 text-sm text-muted">
              No activity recorded
            </div>
          ) : (
            <div className="divide-y border-line">
              {userActivity.map(a => (
                <div
                  key={a.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm border-line"
                >
                  <div>
                    <span className="text-muted">{a.action}</span>
                    {a.appName && (
                      <span className="ml-1 text-accent">
                        {a.appName}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-faint">
                    {formatTime(a.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  }

  // User list view
  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">
            Users
          </h1>
          <p className="mt-1 text-sm text-muted">
            {users.length} registered user{users.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button onClick={fetchUsers} loading={loading}>
          {!loading && <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <Card padded={false} className="overflow-hidden">
        <Table>
          <TableHead>
            <TableRow header>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell className="hidden md:table-cell">Email</TableHeaderCell>
              <TableHeaderCell>Role</TableHeaderCell>
              <TableHeaderCell>Apps</TableHeaderCell>
              <TableHeaderCell>Last Login</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell align="right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {users.map(u => (
              <TableRow
                key={u.id}
                className={cn(
                  'cursor-pointer transition-colors hover:bg-surface-2',
                  !u.enabled && 'opacity-50'
                )}
                onClick={() => selectUser(u)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-faint" />
                    <span className="font-medium text-fg">{u.username}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden text-xs text-muted md:table-cell">
                  {u.email || '-'}
                </TableCell>
                <TableCell>
                  <Badge tone={u.role === 'admin' ? 'accent' : 'neutral'}>{u.role}</Badge>
                </TableCell>
                <TableCell className="text-muted">{u.appCount}</TableCell>
                <TableCell className="text-xs text-muted">{formatDate(u.lastLogin)}</TableCell>
                <TableCell>
                  <span className={cn('text-xs', u.enabled ? 'text-ok' : 'text-err')}>
                    {u.enabled ? 'Active' : 'Disabled'}
                  </span>
                </TableCell>
                <TableCell align="right" onClick={e => e.stopPropagation()}>
                  {u.role !== 'admin' && (
                    <button
                      onClick={() => toggleUser(u.id, !u.enabled)}
                      className="dui-focus-ring rounded text-faint transition-colors hover:text-fg focus-visible:outline-none"
                      title={u.enabled ? 'Disable user' : 'Enable user'}
                      aria-label={u.enabled ? `Disable ${u.username}` : `Enable ${u.username}`}
                    >
                      {u.enabled ? (
                        <ShieldOff className="h-4 w-4" />
                      ) : (
                        <Shield className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

export default UsersPage;
