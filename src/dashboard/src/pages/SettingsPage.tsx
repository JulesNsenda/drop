import { useState, useEffect, useMemo, ReactNode, FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { useHealth, AppHealthCheck } from '../hooks/useApi';
import { getAuthHeaders, useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import {
  Server,
  Database,
  Eye,
  HardDrive,
  Activity,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Lock,
  Clock,
  ShieldCheck,
  ShieldOff,
  Info,
  KeyRound,
  LucideIcon,
  Plug,
  GitBranch,
} from 'lucide-react';
import Tabs, { TabDef } from '../components/Tabs';
import ApiKeysTab from '../components/ApiKeysTab';
import McpConnectorTab from '../components/McpConnectorTab';
import UserConnectorTab from '../components/UserConnectorTab';
import GitWebhooksTab from '../components/GitWebhooksTab';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';

interface ActivityEntry {
  id: string;
  action: string;
  username?: string;
  appName?: string;
  detail?: string;
  timestamp: string;
}

/** Repeated "titled panel" shell used across every Settings tab (PRD-047). */
function SectionCard({
  title,
  icon: Icon,
  headerExtra,
  danger = false,
  className = '',
  children,
}: {
  title: string;
  icon?: LucideIcon;
  headerExtra?: ReactNode;
  danger?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card
      padded={false}
      className={`mb-6 ${className}`}
      style={
        danger ? { borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)' } : undefined
      }
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border)' }}
      >
        {Icon && (
          <Icon className="h-4 w-4" style={{ color: danger ? 'var(--err)' : 'var(--text-3)' }} />
        )}
        <h2 className="font-semibold" style={{ color: danger ? 'var(--err)' : 'var(--text)' }}>
          {title}
        </h2>
        {headerExtra}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

function SkeletonLines() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-4 w-48 rounded" style={{ background: 'var(--bg-2)' }} />
      <div className="h-4 w-36 rounded" style={{ background: 'var(--bg-2)' }} />
    </div>
  );
}

function statusTone(status: string) {
  if (status === 'up' || status === 'healthy') return 'var(--ok)';
  if (status === 'down' || status === 'degraded') return 'var(--err)';
  return 'var(--warn)';
}

function StatusIcon({ status }: { status: string }) {
  const color = statusTone(status);
  if (status === 'up' || status === 'healthy')
    return <CheckCircle className="h-4 w-4" style={{ color }} />;
  if (status === 'down' || status === 'degraded')
    return <XCircle className="h-4 w-4" style={{ color }} />;
  return <AlertTriangle className="h-4 w-4" style={{ color }} />;
}

function SettingsPage() {
  const { health, loading } = useHealth();
  const { role, mfaEnabled, refreshMe } = useAuth();
  const isAdmin = role === 'admin';
  // `readonly` can never complete POST /oauth/approve (authMiddleware('user')
  // there) and would only ever see a 403, so the tab is admin+user only —
  // never unconditional. `role` is briefly undefined while useAuth loads, so
  // this stays false (not a crash or flash) until it resolves.
  const canUseConnectors = role === 'admin' || role === 'user';
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

  // Hydrate MFA (and must-change) status from /auth/me on mount. It is not
  // carried in the login/mfa-verify response or localStorage, and refreshMe()
  // otherwise only runs right after enable/disable — so without this the MFA
  // card shows "Enable MFA" for a user who already has it on once they open
  // Settings in a fresh session.
  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  // Generate QR code when setup URI is available
  useEffect(() => {
    if (!mfaSetupUri) {
      setMfaQrDataUrl('');
      return;
    }
    QRCode.toDataURL(mfaSetupUri, { width: 200, margin: 2 })
      .then(setMfaQrDataUrl)
      .catch(() => {});
  }, [mfaSetupUri]);

  const handleMfaSetupStart = async () => {
    setMfaLoading(true);
    try {
      const res = await fetch('/api/v1/auth/mfa/setup', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
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
    } catch {
      toast('error', 'Network error');
    }
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
    } catch {
      toast('error', 'Network error');
    }
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
    } catch {
      toast('error', 'Network error');
    }
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
    if (!isAdmin) {
      setActivityLoading(false);
      return;
    }
    const fetchActivity = async () => {
      try {
        const res = await fetch('/api/v1/admin/activity?limit=20', { headers: getAuthHeaders() });
        const json = await res.json();
        if (json.success) setActivity(json.data || []);
      } catch {
      } finally {
        setActivityLoading(false);
      }
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 15000);
    return () => clearInterval(interval);
  }, [isAdmin]);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (newPw !== confirmPw) {
      toast('error', 'Passwords do not match');
      return;
    }
    if (newPw.length < 8) {
      toast('error', 'Password must be at least 8 characters');
      return;
    }
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
        setCurrentPw('');
        setNewPw('');
        setConfirmPw('');
      } else {
        toast('error', json.error?.message || 'Failed to change password');
      }
    } catch {
      toast('error', 'Network error');
    }
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

  const availableTabs = useMemo<TabDef[]>(() => {
    const tabs: TabDef[] = [];
    if (isAdmin) tabs.push({ id: 'system', label: 'System', icon: Server });
    tabs.push({ id: 'account', label: 'Account', icon: Lock });
    if (isAdmin) tabs.push({ id: 'api-keys', label: 'API Keys', icon: KeyRound });
    if (canUseConnectors) tabs.push({ id: 'mcp-connector', label: 'Claude (MCP)', icon: Plug });
    if (isAdmin) tabs.push({ id: 'git-webhooks', label: 'Git webhooks', icon: GitBranch });
    if (isAdmin) tabs.push({ id: 'activity', label: 'Activity', icon: Clock });
    tabs.push({ id: 'about', label: 'About', icon: Info });
    return tabs;
    // `canUseConnectors` must be its own dep, not folded into `isAdmin`: role
    // going undefined -> 'user' flips canUseConnectors but not isAdmin, so a
    // memo keyed on isAdmin alone would never recompute and the freshly
    // loaded 'user' account's tab would never appear.
  }, [isAdmin, canUseConnectors]);

  // Invalid or role-forbidden ?tab= values fall back to the role's default
  // without rewriting the URL, so a deep link survives async role loading.
  const requestedTab = searchParams.get('tab');
  const activeTab =
    requestedTab && availableTabs.some(t => t.id === requestedTab)
      ? requestedTab
      : isAdmin
        ? 'system'
        : 'account';

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text)' }}>
          Settings
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          Platform health, configuration, and status
        </p>
      </div>

      <Tabs
        tabs={availableTabs}
        active={activeTab}
        onChange={id => setSearchParams({ tab: id }, { replace: true })}
        label="Settings sections"
      />

      {/* System tab (admin only) */}
      {isAdmin && activeTab === 'system' && (
        <>
          <SectionCard title="System Health" icon={Server}>
            {loading ? (
              <SkeletonLines />
            ) : health ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ background: 'var(--accent-soft)' }}
                  >
                    <Server className="h-5 w-5" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                      Platform
                    </p>
                    <p
                      className="text-sm font-medium capitalize"
                      style={{ color: statusTone(health.status) }}
                    >
                      {health.status}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ background: 'var(--accent-soft)' }}
                  >
                    <HardDrive className="h-5 w-5" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                      Uptime
                    </p>
                    <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                      {formatUptime(health.uptime)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ background: 'var(--accent-soft)' }}
                  >
                    <Activity className="h-5 w-5" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                      Process Manager
                    </p>
                    <p
                      className="text-sm font-medium capitalize"
                      style={{
                        color: statusTone(health.components?.processManager?.status || 'unknown'),
                      }}
                    >
                      {health.components?.processManager?.status || 'Unknown'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ background: 'var(--accent-soft)' }}
                  >
                    <Database className="h-5 w-5" style={{ color: 'var(--accent)' }} />
                  </div>
                  <div>
                    <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                      Database
                    </p>
                    <p
                      className="text-sm font-medium capitalize"
                      style={{
                        color: statusTone(health.components?.database?.status || 'unknown'),
                      }}
                    >
                      {health.components?.database?.status || 'Unknown'}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--text-2)' }}>Unable to fetch system status</p>
            )}
          </SectionCard>

          {/* Component Details */}
          {health && (
            <SectionCard title="Component Details">
              <div className="-m-4 divide-y" style={{ borderColor: 'var(--border)' }}>
                {Object.entries(health.components || {}).map(([name, comp]) => (
                  <div
                    key={name}
                    className="flex items-center justify-between px-4 py-3"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="flex items-center gap-3">
                      <StatusIcon status={comp?.status || 'unknown'} />
                      <span
                        className="text-sm font-medium capitalize"
                        style={{ color: 'var(--text-2)' }}
                      >
                        {name.replace(/([A-Z])/g, ' $1').trim()}
                      </span>
                    </div>
                    <div className="text-right">
                      <span
                        className="text-sm capitalize"
                        style={{ color: statusTone(comp?.status || 'unknown') }}
                      >
                        {comp?.status || 'unknown'}
                      </span>
                      {comp?.message && (
                        <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                          {comp.message}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* App Health Checks */}
          <SectionCard title="App Health Checks" icon={Eye}>
            {appChecksLoading ? (
              <SkeletonLines />
            ) : appChecks.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-2)' }}>
                No running apps to check
              </p>
            ) : (
              <div className="space-y-2">
                {appChecks.map(app => (
                  <div
                    key={app.name}
                    className="flex items-center justify-between rounded-lg px-3 py-2"
                    style={{ background: 'var(--bg-2)' }}
                  >
                    <div className="flex items-center gap-3">
                      <StatusIcon status={app.healthy ? 'up' : 'down'} />
                      <span className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>
                        {app.name}
                      </span>
                      {app.port && (
                        <span className="font-mono text-xs" style={{ color: 'var(--text-3)' }}>
                          :{app.port}
                        </span>
                      )}
                    </div>
                    <span
                      className="text-xs font-medium"
                      style={{ color: app.healthy ? 'var(--ok)' : 'var(--err)' }}
                    >
                      {app.healthy ? 'Responding' : 'Not responding'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          {/* Configuration */}
          <SectionCard title="Configuration">
            <table className="w-full text-sm">
              <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
                <tr style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2" style={{ color: 'var(--text-2)' }}>
                    Version
                  </td>
                  <td className="py-2 font-mono" style={{ color: 'var(--text)' }}>
                    {health?.version || '0.6.0'}
                  </td>
                </tr>
                <tr style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2" style={{ color: 'var(--text-2)' }}>
                    Apps Directory
                  </td>
                  <td className="py-2 font-mono text-xs" style={{ color: 'var(--text)' }}>
                    {health?.system?.appsDirectory ?? '—'}
                  </td>
                </tr>
                <tr style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2" style={{ color: 'var(--text-2)' }}>
                    API Endpoint
                  </td>
                  <td
                    className="py-2 font-mono text-xs"
                    style={{ color: 'var(--text)' }}
                  >{`${window.location.origin}/api/v1`}</td>
                </tr>
                <tr style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2" style={{ color: 'var(--text-2)' }}>
                    Node.js
                  </td>
                  <td className="py-2 font-mono text-xs" style={{ color: 'var(--text)' }}>
                    {typeof process !== 'undefined' ? 'Runtime' : 'N/A'}
                  </td>
                </tr>
              </tbody>
            </table>
          </SectionCard>
        </>
      )}

      {/* Account tab */}
      {activeTab === 'account' && (
        <>
          {/* Change Password */}
          <SectionCard title="Change Password" icon={Lock}>
            <form onSubmit={handleChangePassword} className="max-w-md space-y-3">
              <Input
                type="password"
                value={currentPw}
                onChange={e => setCurrentPw(e.target.value)}
                placeholder="Current password"
                required
              />
              <Input
                type="password"
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                placeholder="New password (min 8 chars)"
                required
                minLength={8}
              />
              <Input
                type="password"
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                placeholder="Confirm new password"
                required
              />
              <Button type="submit" loading={pwLoading}>
                {pwLoading ? 'Changing...' : 'Change password'}
              </Button>
            </form>
          </SectionCard>

          {/* Two-Factor Authentication */}
          <SectionCard
            title="Two-Factor Authentication"
            icon={ShieldCheck}
            headerExtra={
              mfaEnabled ? (
                <Badge tone="ok" className="ml-1">
                  Enabled
                </Badge>
              ) : undefined
            }
          >
            {mfaStep === 'idle' && (
              <div>
                {mfaEnabled ? (
                  <div>
                    <p className="mb-3 text-sm" style={{ color: 'var(--text-2)' }}>
                      Two-factor authentication is active. Your account requires a code from your
                      authenticator app on each login.
                    </p>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setMfaStep('disable');
                        setMfaCode('');
                      }}
                    >
                      <ShieldOff className="h-4 w-4" />
                      Disable two-factor authentication
                    </Button>
                  </div>
                ) : (
                  <div>
                    <p className="mb-3 text-sm" style={{ color: 'var(--text-2)' }}>
                      Add an extra layer of security to your account. You'll need an authenticator
                      app (Google Authenticator, Authy, 1Password, etc.).
                    </p>
                    <Button onClick={handleMfaSetupStart} loading={mfaLoading}>
                      {!mfaLoading && <ShieldCheck className="h-4 w-4" />}
                      {mfaLoading ? 'Setting up...' : 'Enable two-factor authentication'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {mfaStep === 'setup' && (
              <form onSubmit={handleMfaEnable} className="max-w-sm space-y-4">
                <div>
                  <p className="mb-2 text-sm font-medium" style={{ color: 'var(--text-2)' }}>
                    1. Scan this QR code with your authenticator app
                  </p>
                  {mfaQrDataUrl ? (
                    <img
                      src={mfaQrDataUrl}
                      alt="TOTP QR code"
                      className="rounded-lg border"
                      style={{ width: 200, height: 200, borderColor: 'var(--border)' }}
                    />
                  ) : (
                    <div
                      className="flex h-48 w-48 items-center justify-center rounded-lg"
                      style={{ background: 'var(--bg-2)' }}
                    >
                      <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                        Generating...
                      </span>
                    </div>
                  )}
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-3)' }}>
                    Can't scan? Enter this secret manually:
                  </p>
                  <code className="mt-1 block break-all">{mfaSetupSecret}</code>
                </div>

                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: 'var(--text-2)' }}
                  >
                    2. Enter the 6-digit code to confirm
                  </label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    required
                    className="text-center text-xl font-mono tracking-widest"
                  />
                </div>

                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: 'var(--text-2)' }}
                  >
                    3. Confirm your account password
                  </label>
                  <Input
                    type="password"
                    value={mfaPassword}
                    onChange={e => setMfaPassword(e.target.value)}
                    placeholder="Current password"
                    required
                  />
                </div>

                <div className="flex gap-3">
                  <Button
                    type="submit"
                    loading={mfaLoading}
                    disabled={mfaCode.length !== 6 || !mfaPassword}
                  >
                    {mfaLoading ? 'Activating...' : 'Activate'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setMfaStep('idle');
                      setMfaSetupUri('');
                      setMfaSetupSecret('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>

                <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                  Lost your device? Run <code>drop mfa disable &lt;username&gt;</code> on the server
                  to recover access.
                </p>
              </form>
            )}

            {mfaStep === 'disable' && (
              <form onSubmit={handleMfaDisable} className="max-w-sm space-y-4">
                <p className="text-sm" style={{ color: 'var(--text-2)' }}>
                  Enter a current code from your authenticator app to disable two-factor
                  authentication.
                </p>
                <div>
                  <label
                    className="mb-1 block text-sm font-medium"
                    style={{ color: 'var(--text-2)' }}
                  >
                    Authentication code
                  </label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    required
                    autoFocus
                    className="text-center text-xl font-mono tracking-widest"
                  />
                </div>
                <div className="flex gap-3">
                  <Button
                    type="submit"
                    variant="danger"
                    loading={mfaLoading}
                    disabled={mfaCode.length !== 6}
                  >
                    {mfaLoading ? 'Disabling...' : 'Disable 2FA'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setMfaStep('idle');
                      setMfaCode('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </SectionCard>

          {/* Delete Account */}
          {!isAdmin && (
            <SectionCard title="Danger Zone" danger>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                    Delete account
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-3)' }}>
                    Permanently remove your account and all your apps
                  </p>
                </div>
                <Button
                  variant="danger"
                  onClick={async () => {
                    const confirmed = await confirmDialog({
                      title: 'Delete account',
                      message:
                        'This will permanently delete your account and all your deployed applications. This cannot be undone.',
                      confirmText: 'Delete my account',
                      variant: 'danger',
                    });
                    if (!confirmed) return;
                    try {
                      const res = await fetch('/api/v1/auth/account', {
                        method: 'DELETE',
                        headers: getAuthHeaders(),
                      });
                      const json = await res.json();
                      if (json.success) {
                        localStorage.clear();
                        window.location.href = '/dashboard';
                      } else {
                        toast('error', json.error?.message || 'Failed to delete account');
                      }
                    } catch {
                      toast('error', 'Network error');
                    }
                  }}
                >
                  Delete account
                </Button>
              </div>
            </SectionCard>
          )}
        </>
      )}

      {/* API Keys tab (admin only) */}
      {isAdmin && activeTab === 'api-keys' && <ApiKeysTab />}

      {/* Claude (MCP) connector tab (admin + user; readonly never sees it) */}
      {isAdmin && activeTab === 'mcp-connector' && <McpConnectorTab />}
      {!isAdmin && canUseConnectors && activeTab === 'mcp-connector' && <UserConnectorTab />}

      {/* Git webhooks tab (admin only) */}
      {isAdmin && activeTab === 'git-webhooks' && <GitWebhooksTab />}

      {/* Activity tab (admin only) */}
      {isAdmin && activeTab === 'activity' && (
        <SectionCard title="Recent Activity" icon={Clock}>
          {activityLoading ? (
            <SkeletonLines />
          ) : activity.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              No activity yet
            </p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-auto">
              {activity.map(a => (
                <div key={a.id} className="flex items-center justify-between py-1.5 text-sm">
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-2)' }}>
                      {a.username || 'system'}
                    </span>
                    <span style={{ color: 'var(--text-2)' }}> {a.action}</span>
                    {a.appName && <span style={{ color: 'var(--accent)' }}> {a.appName}</span>}
                    {a.detail && (
                      <span className="ml-1 text-xs" style={{ color: 'var(--text-3)' }}>
                        ({a.detail})
                      </span>
                    )}
                  </div>
                  <span
                    className="ml-4 whitespace-nowrap text-xs"
                    style={{ color: 'var(--text-3)' }}
                  >
                    {new Date(a.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {/* About tab */}
      {activeTab === 'about' && (
        <SectionCard title="About DROP">
          <p className="mb-4 text-sm" style={{ color: 'var(--text-2)' }}>
            DROP (Deploy, Run, Operate, Publish) is a lightweight, self-hosted PaaS for
            zero-configuration deployments. Drop a folder and get a running application.
          </p>
          <div className="flex gap-4">
            <a
              href="https://github.com/JulesNsenda/drop"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm"
            >
              GitHub
            </a>
            <a
              href="https://github.com/JulesNsenda/drop/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm"
            >
              Changelog
            </a>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

export default SettingsPage;
