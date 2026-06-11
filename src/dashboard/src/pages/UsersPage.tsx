import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, Shield, ShieldOff, RefreshCw, ArrowLeft } from 'lucide-react';
import { getAuthHeaders } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import StatusBadge from '../components/StatusBadge';
import { App } from '../hooks/useApi';

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
      if (json.success) setUsers(json.data || []);
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchUsers(); }, []);

  const selectUser = async (user: UserInfo) => {
    setSelectedUser(user);

    // Fetch all apps and filter by userId
    try {
      const res = await fetch('/api/v1/apps', { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) {
        setUserApps((json.data || []).filter((a: App) => a.userId === user.id));
      }
    } catch { setUserApps([]); }

    // Fetch activity filtered by username
    try {
      const res = await fetch('/api/v1/admin/activity?limit=50', { headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) {
        setUserActivity((json.data || []).filter((a: ActivityEntry) => a.username === user.username).slice(0, 15));
      }
    } catch { setUserActivity([]); }
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

  const formatDate = (d?: string) => d ? new Date(d).toLocaleDateString() : 'Never';
  const formatTime = (d: string) => new Date(d).toLocaleString();

  // User detail view
  if (selectedUser) {
    return (
      <div className="p-6">
        <button onClick={() => setSelectedUser(null)} className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-drop-600 mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to users
        </button>

        {/* User header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{selectedUser.username}</h1>
            {selectedUser.email && (
              <p className="text-sm text-gray-500 dark:text-gray-400">{selectedUser.email}</p>
            )}
            <div className="flex items-center gap-3 mt-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                selectedUser.role === 'admin'
                  ? 'bg-drop-100 dark:bg-drop-900/30 text-drop-700 dark:text-drop-400'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
              }`}>{selectedUser.role}</span>
              <span className={`text-xs ${selectedUser.enabled ? 'text-green-600' : 'text-red-500'}`}>
                {selectedUser.enabled ? 'Active' : 'Disabled'}
              </span>
              <span className="text-xs text-gray-500">Joined {formatDate(selectedUser.createdAt)}</span>
            </div>
          </div>
          {selectedUser.role !== 'admin' && (
            <button
              onClick={() => toggleUser(selectedUser.id, !selectedUser.enabled)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${
                selectedUser.enabled
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200'
                  : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200'
              }`}
            >
              {selectedUser.enabled ? <><ShieldOff className="w-4 h-4" /> Disable</> : <><Shield className="w-4 h-4" /> Enable</>}
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Applications</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{userApps.length}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">App Limit</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={selectedUser.maxApps || 0}
                onChange={(e) => setSelectedUser({ ...selectedUser, maxApps: parseInt(e.target.value) || 0 })}
                className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
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
                className="text-xs text-drop-600 hover:text-drop-500"
              >
                Save
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">0 = use global default</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Last Login</p>
            <p className="text-sm font-medium text-gray-900 dark:text-white">{formatDate(selectedUser.lastLogin)}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Recent Actions</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">{userActivity.length}</p>
          </div>
        </div>

        {/* User's apps */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h2 className="font-semibold text-gray-900 dark:text-white">Applications</h2>
          </div>
          {userApps.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No applications deployed</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {userApps.map((app) => (
                <Link key={app.name} to={`/apps/${app.name}`} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white text-sm">{app.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{app.type}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {app.port && (
                      <span className="text-xs text-gray-400 font-mono">:{app.port}</span>
                    )}
                    <StatusBadge status={app.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Reset password (admin action) */}
        {selectedUser.role !== 'admin' && (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h2 className="font-semibold text-gray-900 dark:text-white">Reset Password</h2>
            </div>
            <div className="p-4 flex gap-2 max-w-md">
              <input
                type="password"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                placeholder="New password (min 8 chars)"
                minLength={8}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500"
              />
              <button
                onClick={async () => {
                  if (resetPw.length < 8) { toast('error', 'Min 8 characters'); return; }
                  const res = await fetch(`/api/v1/auth/users/${selectedUser.id}/reset-password`, {
                    method: 'POST',
                    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newPassword: resetPw }),
                  });
                  const json = await res.json();
                  if (json.success) { toast('success', 'Password reset'); setResetPw(''); }
                  else toast('error', json.error?.message || 'Failed');
                }}
                disabled={resetPw.length < 8}
                className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium"
              >
                Reset
              </button>
            </div>
          </div>
        )}

        {/* User's activity */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h2 className="font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
          </div>
          {userActivity.length === 0 ? (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400">No activity recorded</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {userActivity.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div>
                    <span className="text-gray-600 dark:text-gray-400">{a.action}</span>
                    {a.appName && <span className="text-drop-600 dark:text-drop-400 ml-1">{a.appName}</span>}
                  </div>
                  <span className="text-xs text-gray-400">{formatTime(a.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // User list view
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={fetchUsers} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">User</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 hidden md:table-cell">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Role</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Apps</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Last Login</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
              <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {users.map((u) => (
              <tr
                key={u.id}
                className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${u.enabled ? '' : 'opacity-50'}`}
                onClick={() => selectUser(u)}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-gray-400" />
                    <span className="font-medium text-gray-900 dark:text-white">{u.username}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs hidden md:table-cell">{u.email || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    u.role === 'admin'
                      ? 'bg-drop-100 dark:bg-drop-900/30 text-drop-700 dark:text-drop-400'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                  }`}>{u.role}</span>
                </td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{u.appCount}</td>
                <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{formatDate(u.lastLogin)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs ${u.enabled ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                    {u.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {u.role !== 'admin' && (
                    <button
                      onClick={() => toggleUser(u.id, !u.enabled)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                      title={u.enabled ? 'Disable user' : 'Enable user'}
                    >
                      {u.enabled ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UsersPage;
