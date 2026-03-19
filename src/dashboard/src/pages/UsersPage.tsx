import { useState, useEffect } from 'react';
import { Users, Shield, ShieldOff, RefreshCw } from 'lucide-react';
import { getAuthHeaders } from '../hooks/useAuth';
import { useToast } from '../components/Toast';

interface UserInfo {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
  appCount: number;
  createdAt: string;
  lastLogin?: string;
}

function UsersPage() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
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
    } else {
      toast('error', json.error?.message || 'Failed');
    }
  };

  const formatDate = (d?: string) => d ? new Date(d).toLocaleDateString() : 'Never';

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
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Role</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Apps</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Last Login</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
              <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {users.map((u) => (
              <tr key={u.id} className={u.enabled ? '' : 'opacity-50'}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-gray-400" />
                    <span className="font-medium text-gray-900 dark:text-white">{u.username}</span>
                  </div>
                </td>
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
                <td className="px-4 py-3 text-right">
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
