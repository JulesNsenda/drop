import { useState, useEffect, useMemo, FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { useHealth, AppHealthCheck } from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { Server, Database, Eye, HardDrive, Activity, CheckCircle, XCircle, AlertTriangle, Lock, Clock, ShieldCheck, ShieldOff, Info, KeyRound } from 'lucide-react';
import Tabs, { TabDef } from '../components/Tabs';
import ApiKeysTab from '../components/ApiKeysTab';

interface ActivityEntry {
  id: string;
  action: string;
  username?: string;
  appName?: string;
  detail?: string;
  timestamp: string;
}

function SettingsPage() {
  const { health, loading } = useHealth();
  const { role, mfaEnabled, refreshMe } = useAuth();
  const isAdmin = role === 'admin';
  const { toast } = useToast();
  const confirmDialog = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const [appChecks, setAppChecks] = useState<AppHealthCheck[]>([]);
  const [appChecksLoading, setAppChecksLoading] = useState(true);

  // Change password
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);

  // MFA setup state
  const [mfaStep, setMfaStep] = useState<'idle' | 'setup' | 'disable'>('idle');
  const [mfaSetupUri, setMfaSetupUri] = useState('');
  const [mfaSetupSecret, setMfaSetupSecret] = useState('');
  const [mfaQrDataUrl, setMfaQrDataUrl] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaLoading, setMfaLoading] = useState(false);

  // Activity log (admin only)
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  // Generate QR code when setup URI is available
  useEffect(() => {
    if (!mfaSetupUri) { setMfaQrDataUrl(''); return; }
    QRCode.toDataURL(mfaSetupUri, { width: 200, margin: 2 }).then(setMfaQrDataUrl).catch(() => {});
  }, [mfaSetupUri]);

  const handleMfaSetupStart = async () => {
    setMfaLoading(true);
    try {
      const res = await fetch('/api/v1/auth/mfa/setup', { method: 'POST', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.success) {
        setMfaSetupUri(json.data.uri);
        setMfaSetupSecret(json.data.secret);
        setMfaCode('');
        setMfaPassword('');
        setMfaStep('setup');
      } else {
        toast('error', json.error?.message || 'Failed to start setup');
      }
    } catch { toast('error', 'Network error'); }
    setMfaLoading(false);
  };

  const handleMfaEnable = async (e: FormEvent) => {
    e.preventDefault();
    setMfaLoading(true);
    try {
      const res = await fetch('/api/v1/auth/mfa/enable', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: mfaPassword, secret: mfaSetupSecret, code: mfaCode }),
      });
      const json = await res.json();
      if (json.success) {
        toast('success', 'Two-factor authentication enabled');
        setMfaStep('idle');
        setMfaSetupUri('');
        setMfaSetupSecret('');
        setMfaCode('');
        setMfaPassword('');
        await refreshMe();
      } else {
        toast('error', json.error?.message || 'Failed to enable MFA');
      }
    } catch { toast('error', 'Network error'); }
    setMfaLoading(false);
  };

  const handleMfaDisable = async (e: FormEvent) => {
    e.preventDefault();
    setMfaLoading(true);
    try {
      const res = await fetch('/api/v1/auth/mfa/disable', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: mfaCode }),
      });
      const json = await res.json();
      if (json.success) {
        toast('success', 'Two-factor authentication disabled');
        setMfaStep('idle');
        setMfaCode('');
        await refreshMe();
      } else {
        toast('error', json.error?.message || 'Failed to disable MFA');
      }
    } catch { toast('error', 'Network error'); }
    setMfaLoading(false);
  };

  useEffect(() => {
    const fetchAppHealth = async () => {
      try {
        const res = await fetch('/api/v1/health/apps', { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success && json.data) {
          setAppChecks(json.data);
        }
      } catch {
        // ignore
      } finally {
        setAppChecksLoading(false);
      }
    };

    fetchAppHealth();
    const interval = setInterval(fetchAppHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  // Fetch activity log (admin only)
  useEffect(() => {
    if (!isAdmin) { setActivityLoading(false); return; }
    const fetchActivity = async () => {
      try {
        const res = await fetch('/api/v1/admin/activity?limit=20', { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success) setActivity(json.data || []);
      } catch {} finally { setActivityLoading(false); }
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 15000);
    return () => clearInterval(interval);
  }, [isAdmin]);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPw !== confirmPw) { toast('error', 'Passwords do not match'); return; }
    if (newPw.length < 8) { toast('error', 'Password must be at least 8 characters'); return; }
    setPwLoading(true);
    try {
      const res = await fetch('/api/v1/auth/password', {
        method: 'PUT',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const json = await res.json();
      if (json.success) {
        toast('success', 'Password changed');
        setCurrentPw(''); setNewPw(''); setConfirmPw('');
      } else {
        toast('error', json.error?.message || 'Failed to change password');
      }
    } catch { toast('error', 'Network error'); }
    setPwLoading(false);
  };

  const formatUptime = (seconds?: number) => {
    if (!seconds) return 'Unknown';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const StatusIcon = ({ status }: { status: string }) => {
    if (status === 'up' || status === 'healthy') return <CheckCircle className="w-4 h-4 text-green-500" />;
    if (status === 'down' || status === 'degraded') return <XCircle className="w-4 h-4 text-red-500" />;
    return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
  };

  const statusColor = (status: string) => {
    if (status === 'up' || status === 'healthy') return 'text-green-600 dark:text-green-400';
    if (status === 'down' || status === 'degraded') return 'text-red-600 dark:text-red-400';
    return 'text-yellow-600 dark:text-yellow-400';
  };

  const availableTabs = useMemo<TabDef[]>(() => {
    const tabs: TabDef[] = [];
    if (isAdmin) tabs.push({ id: 'system', label: 'System', icon: Server });
    tabs.push({ id: 'account', label: 'Account', icon: Lock });
    if (isAdmin) tabs.push({ id: 'api-keys', label: 'API Keys', icon: KeyRound });
    if (isAdmin) tabs.push({ id: 'activity', label: 'Activity', icon: Clock });
    tabs.push({ id: 'about', label: 'About', icon: Info });
    return tabs;
  }, [isAdmin]);

  // Invalid or role-forbidden ?tab= values fall back to the role's default
  // without rewriting the URL, so a deep link survives async role loading.
  const requestedTab = searchParams.get('tab');
  const activeTab =
    requestedTab && availableTabs.some((t) => t.id === requestedTab)
      ? requestedTab
      : isAdmin
        ? 'system'
        : 'account';

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Platform health, configuration, and status</p>
      </div>

      <Tabs
        tabs={availableTabs}
        active={activeTab}
        onChange={(id) => setSearchParams({ tab: id }, { replace: true })}
      />

      {/* System tab (admin only) */}
      {isAdmin && activeTab === 'system' && <>
      {/* System Health */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">System Health</h2>
        </div>
        <div className="p-4">
          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
              <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ) : health ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                  <Server className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Platform</p>
                  <p className={`text-sm font-medium capitalize ${statusColor(health.status)}`}>{health.status}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <HardDrive className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Uptime</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{formatUptime(health.uptime)}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                  <Activity className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Process Manager</p>
                  <p className={`text-sm font-medium capitalize ${statusColor(health.components?.processManager?.status || 'unknown')}`}>
                    {health.components?.processManager?.status || 'Unknown'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                  <Database className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Database</p>
                  <p className={`text-sm font-medium capitalize ${statusColor(health.components?.database?.status || 'unknown')}`}>
                    {health.components?.database?.status || 'Unknown'}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">Unable to fetch system status</p>
          )}
        </div>
      </div>

      {/* Component Details */}
      {health && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h2 className="font-semibold text-gray-900 dark:text-white">Component Details</h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {Object.entries(health.components || {}).map(([name, comp]) => (
              <div key={name} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusIcon status={comp?.status || 'unknown'} />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">{name.replace(/([A-Z])/g, ' $1').trim()}</span>
                </div>
                <div className="text-right">
                  <span className={`text-sm capitalize ${statusColor(comp?.status || 'unknown')}`}>
                    {comp?.status || 'unknown'}
                  </span>
                  {comp?.message && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">{comp.message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* App Health Checks */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-gray-500" />
            <h2 className="font-semibold text-gray-900 dark:text-white">App Health Checks</h2>
          </div>
        </div>
        <div className="p-4">
          {appChecksLoading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
              <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ) : appChecks.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No running apps to check</p>
          ) : (
            <div className="space-y-2">
              {appChecks.map((app) => (
                <div key={app.name} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                  <div className="flex items-center gap-3">
                    <StatusIcon status={app.healthy ? 'up' : 'down'} />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{app.name}</span>
                    {app.port && (
                      <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">:{app.port}</span>
                    )}
                  </div>
                  <span className={`text-xs font-medium ${app.healthy ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {app.healthy ? 'Responding' : 'Not responding'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Configuration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">Configuration</h2>
        </div>
        <div className="p-4">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Version</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white">{health?.version || '0.6.0'}</td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Apps Directory</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white text-xs">
                  {health?.system?.appsDirectory ?? '—'}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">API Endpoint</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white text-xs">{`${window.location.origin}/api/v1`}</td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Node.js</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white text-xs">{typeof process !== 'undefined' ? 'Runtime' : 'N/A'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      </>}

      {/* Account tab */}
      {activeTab === 'account' && <>
      {/* Change Password */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-gray-500" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Change Password</h2>
          </div>
        </div>
        <form onSubmit={handleChangePassword} className="p-4 space-y-3 max-w-md">
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder="Current password" required className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500" />
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (min 8 chars)" required minLength={8} className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500" />
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="Confirm new password" required className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500" />
          <button type="submit" disabled={pwLoading} className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium">
            {pwLoading ? 'Changing...' : 'Change password'}
          </button>
        </form>
      </div>

      {/* Two-Factor Authentication */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-gray-500" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Two-Factor Authentication</h2>
            {mfaEnabled && (
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full">Enabled</span>
            )}
          </div>
        </div>
        <div className="p-4">
          {mfaStep === 'idle' && (
            <div>
              {mfaEnabled ? (
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    Two-factor authentication is active. Your account requires a code from your authenticator app on each login.
                  </p>
                  <button
                    onClick={() => { setMfaStep('disable'); setMfaCode(''); }}
                    className="flex items-center gap-2 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50 text-sm font-medium transition-colors"
                  >
                    <ShieldOff className="w-4 h-4" />
                    Disable two-factor authentication
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    Add an extra layer of security to your account. You'll need an authenticator app (Google Authenticator, Authy, 1Password, etc.).
                  </p>
                  <button
                    onClick={handleMfaSetupStart}
                    disabled={mfaLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium transition-colors"
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {mfaLoading ? 'Setting up...' : 'Enable two-factor authentication'}
                  </button>
                </div>
              )}
            </div>
          )}

          {mfaStep === 'setup' && (
            <form onSubmit={handleMfaEnable} className="space-y-4 max-w-sm">
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  1. Scan this QR code with your authenticator app
                </p>
                {mfaQrDataUrl ? (
                  <img src={mfaQrDataUrl} alt="TOTP QR code" className="rounded-lg border border-gray-200 dark:border-gray-700" style={{ width: 200, height: 200 }} />
                ) : (
                  <div className="w-48 h-48 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center">
                    <span className="text-xs text-gray-400">Generating...</span>
                  </div>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Can't scan? Enter this secret manually:
                </p>
                <code className="block mt-1 text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-3 py-2 rounded break-all">
                  {mfaSetupSecret}
                </code>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  2. Enter the 6-digit code to confirm
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  required
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center text-xl font-mono tracking-widest outline-none focus:ring-2 focus:ring-drop-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  3. Confirm your account password
                </label>
                <input
                  type="password"
                  value={mfaPassword}
                  onChange={(e) => setMfaPassword(e.target.value)}
                  placeholder="Current password"
                  required
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-drop-500"
                />
              </div>

              <div className="flex gap-3">
                <button type="submit" disabled={mfaLoading || mfaCode.length !== 6 || !mfaPassword} className="px-4 py-2 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 text-sm font-medium">
                  {mfaLoading ? 'Activating...' : 'Activate'}
                </button>
                <button type="button" onClick={() => { setMfaStep('idle'); setMfaSetupUri(''); setMfaSetupSecret(''); }} className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm">
                  Cancel
                </button>
              </div>

              <p className="text-xs text-gray-400 dark:text-gray-500">
                Lost your device? Run <code className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">drop mfa disable &lt;username&gt;</code> on the server to recover access.
              </p>
            </form>
          )}

          {mfaStep === 'disable' && (
            <form onSubmit={handleMfaDisable} className="space-y-4 max-w-sm">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Enter a current code from your authenticator app to disable two-factor authentication.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Authentication code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  required
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-center text-xl font-mono tracking-widest outline-none focus:ring-2 focus:ring-drop-500"
                />
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={mfaLoading || mfaCode.length !== 6} className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm font-medium">
                  {mfaLoading ? 'Disabling...' : 'Disable 2FA'}
                </button>
                <button type="button" onClick={() => { setMfaStep('idle'); setMfaCode(''); }} className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-sm">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Delete Account */}
      {!isAdmin && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-red-200 dark:border-red-800/50 mb-6">
          <div className="px-4 py-3 border-b border-red-200 dark:border-red-800/50">
            <h2 className="font-semibold text-red-600 dark:text-red-400">Danger Zone</h2>
          </div>
          <div className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">Delete account</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Permanently remove your account and all your apps</p>
            </div>
            <button
              onClick={async () => {
                const confirmed = await confirmDialog({ title: 'Delete account', message: 'This will permanently delete your account and all your deployed applications. This cannot be undone.', confirmText: 'Delete my account', variant: 'danger' });
                if (!confirmed) return;
                try {
                  const res = await fetch('/api/v1/auth/account', { method: 'DELETE', headers: getAuthHeaders() });
                  const json = await res.json();
                  if (json.success) {
                    localStorage.clear();
                    window.location.href = '/dashboard';
                  } else {
                    toast('error', json.error?.message || 'Failed to delete account');
                  }
                } catch { toast('error', 'Network error'); }
              }}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"
            >
              Delete account
            </button>
          </div>
        </div>
      )}
      </>}

      {/* API Keys tab (admin only) */}
      {isAdmin && activeTab === 'api-keys' && <ApiKeysTab />}

      {/* Activity tab (admin only) */}
      {isAdmin && activeTab === 'activity' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-500" />
              <h2 className="font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
            </div>
          </div>
          <div className="p-4">
            {activityLoading ? (
              <div className="animate-pulse space-y-2">
                <div className="h-4 w-64 bg-gray-200 dark:bg-gray-700 rounded" />
                <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
              </div>
            ) : activity.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No activity yet</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-auto">
                {activity.map((a) => (
                  <div key={a.id} className="flex items-center justify-between py-1.5 text-sm">
                    <div>
                      <span className="font-medium text-gray-700 dark:text-gray-300">{a.username || 'system'}</span>
                      <span className="text-gray-500 dark:text-gray-400"> {a.action}</span>
                      {a.appName && <span className="text-drop-600 dark:text-drop-400"> {a.appName}</span>}
                      {a.detail && <span className="text-gray-400 text-xs ml-1">({a.detail})</span>}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap ml-4">{new Date(a.timestamp).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* About tab */}
      {activeTab === 'about' && (
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">About DROP</h2>
        </div>
        <div className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            DROP (Deploy, Run, Operate, Publish) is a lightweight, self-hosted PaaS for
            zero-configuration deployments. Drop a folder and get a running application.
          </p>
          <div className="flex gap-4">
            <a href="https://github.com/JulesNsenda/drop" target="_blank" rel="noopener noreferrer" className="text-sm text-drop-600 hover:underline">
              GitHub
            </a>
            <a href="https://github.com/JulesNsenda/drop/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer" className="text-sm text-drop-600 hover:underline">
              Changelog
            </a>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

export default SettingsPage;
