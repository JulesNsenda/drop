/**
 * The admin settings that had an API endpoint and no way to reach them
 * (DROP-165).
 *
 * `app-sharing`, `guest-invites`, `mail` and `sql-console` were all shipped
 * with a `PUT /admin/settings/...` route and no control, so turning any of them
 * on meant `curl` with a hand-extracted JWT. Most of the 1.5.0 sharing program
 * was effectively unreachable that way, and the SQL console's own refusal
 * message told the operator to "enable it in Settings" — a place that did not
 * exist.
 *
 * Each switch carries its consequence next to it rather than in a doc. These
 * are not preferences: three of the four widen who can reach something, and one
 * of those (the SQL console) exposes a property no privilege setting can close.
 * A settings page that renders them as bare switches invites them to be flipped
 * without that being read.
 */

import { useCallback, useEffect, useState } from 'react';
import { Share2, UserPlus, Terminal, Mail, AlertTriangle } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import Button from './ui/Button';
import Input from './ui/Input';
import { SkeletonText } from './ui/Skeleton';

interface BoolSetting {
  enabled: boolean;
  /** Returned by PUT /settings/app-sharing when the boot-time gate contradicts it. */
  warning?: string;
}

interface SqlConsoleSetting extends BoolSetting {
  adminOnly?: boolean;
  catalogVisibility?: string;
}

interface MailSetting {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  shareNotificationsEnabled: boolean;
  credentialConfigured: boolean;
}

interface AdminSettings {
  appSharing?: BoolSetting;
  guestInvites?: BoolSetting;
  sqlConsole?: SqlConsoleSetting;
  mail?: MailSetting;
}

/**
 * One switch, its label, and the thing an operator should know before flipping
 * it. `consequence` is required rather than optional on purpose — every setting
 * on this page changes who can reach something.
 */
function SettingToggle({
  id,
  icon: Icon,
  label,
  consequence,
  checked,
  busy,
  warning,
  onChange,
}: {
  id: string;
  icon: typeof Share2;
  label: string;
  consequence: React.ReactNode;
  checked: boolean;
  busy: boolean;
  warning?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="rounded-lg border p-4 border-line bg-surface-2">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="h-4 w-4 rounded accent-accent"
          disabled={busy}
        />
        <Icon className="h-4 w-4 text-faint" aria-hidden="true" />
        <label htmlFor={id} className="text-sm font-semibold text-fg">
          {label}
        </label>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">{consequence}</p>
      {warning && (
        <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-err">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>
      )}
    </div>
  );
}

function PlatformSettingsTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  // Mail is a form, not a switch, so it needs local draft state. Seeded from
  // the server once loaded; `credentialConfigured` is never a draft field
  // because the password is write-only — the API reports whether one exists and
  // never what it is.
  const [mailDraft, setMailDraft] = useState({ host: '', port: '', user: '', from: '', secure: false });
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');

  const load = useCallback(async () => {
    const json = await apiJson<AdminSettings>('/admin/settings');
    if (json.success && json.data) {
      setSettings(json.data);
      const m = json.data.mail;
      setMailDraft({
        host: m?.host ?? '',
        port: m?.port ? String(m.port) : '',
        user: m?.user ?? '',
        from: m?.from ?? '',
        secure: m?.secure ?? false,
      });
    } else {
      toast('error', json.error?.message ?? 'Could not load settings.');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /** PUT one boolean setting and fold the response back in. */
  const setFlag = async (
    key: 'appSharing' | 'guestInvites' | 'sqlConsole',
    path: string,
    enabled: boolean,
    onLabel: string
  ) => {
    setBusy(key);
    const json = await apiJson<BoolSetting>(`/admin/settings/${path}`, {
      method: 'PUT',
      ...jsonBody({ enabled }),
    });
    if (json.success && json.data) {
      // Merge rather than replace: these endpoints return only their own block,
      // so assigning the response wholesale would blank every sibling.
      setSettings(prev => (prev ? { ...prev, [key]: { ...prev[key], ...json.data } } : prev));
      toast('success', `${onLabel} ${enabled ? 'enabled' : 'disabled'}`);
      if (json.data.warning) toast('error', json.data.warning);
    } else {
      toast('error', json.error?.message ?? 'Failed to update the setting.');
    }
    setBusy('');
  };

  const saveMail = async () => {
    setBusy('mail');
    const port = mailDraft.port.trim();
    const json = await apiJson<MailSetting>('/admin/settings/mail', {
      method: 'PUT',
      // Empty means "clear it" — the API takes null for host/port/user/from,
      // and sending '' instead would be a validation error rather than a clear.
      ...jsonBody({
        host: mailDraft.host.trim() || null,
        port: port ? Number(port) : null,
        user: mailDraft.user.trim() || null,
        from: mailDraft.from.trim() || null,
        secure: mailDraft.secure,
      }),
    });
    if (json.success && json.data) {
      setSettings(prev => (prev ? { ...prev, mail: json.data! } : prev));
      // Changing the host CLEARS the stored password server-side: a saved
      // credential belongs to the relay it was set for. Saying so here means
      // the operator is not surprised by `credentialConfigured` flipping.
      toast(
        'success',
        json.data.credentialConfigured
          ? 'Mail settings saved'
          : 'Mail settings saved — set the relay password below'
      );
    } else {
      toast('error', json.error?.message ?? 'Failed to save mail settings.');
    }
    setBusy('');
  };

  const saveCredential = async () => {
    setBusy('credential');
    const json = await apiJson('/admin/settings/mail/credential', {
      method: 'PUT',
      ...jsonBody({ password }),
    });
    if (json.success) {
      setPassword('');
      toast('success', 'Relay password saved');
      await load();
    } else {
      toast('error', json.error?.message ?? 'Failed to save the password.');
    }
    setBusy('');
  };

  const sendTest = async () => {
    setBusy('test');
    const json = await apiJson<{ status?: string }>('/admin/mail/test', {
      method: 'POST',
      ...jsonBody({ to: testTo.trim() }),
    });
    if (json.success) toast('success', `Test message sent to ${testTo.trim()}`);
    else toast('error', json.error?.message ?? 'Test send failed.');
    setBusy('');
  };

  if (loading) return <SkeletonText label="Loading settings" className="space-y-3" />;

  const mail = settings?.mail;

  return (
    <>
      <Card padded={false} className="mb-6">
        <div className="flex items-center gap-2 border-b px-4 py-3 border-line">
          <Share2 className="h-4 w-4 text-faint" aria-hidden="true" />
          <h2 className="font-semibold text-fg">Platform features</h2>
        </div>
        <div className="space-y-4 p-4">
          <SettingToggle
            id="appSharingEnabled"
            icon={Share2}
            label="Let owners share their apps"
            consequence={
              <>
                An app&apos;s owner can grant a colleague access without an admin round-trip.
                Sharing only takes effect on apps that are behind the access gate; it does not
                let the person deploy, restart, or read secrets.
              </>
            }
            checked={settings?.appSharing?.enabled ?? false}
            busy={busy === 'appSharing'}
            warning={settings?.appSharing?.warning}
            onChange={next => void setFlag('appSharing', 'app-sharing', next, 'App sharing')}
          />

          <SettingToggle
            id="guestInvitesEnabled"
            icon={UserPlus}
            label="Let owners invite guests by email"
            consequence={
              <>
                Someone with <strong>no DROP account</strong> can be invited to exactly one app
                and redeem a single-use emailed invitation. Needs outbound mail configured below
                — without a relay the invitation cannot be delivered.
              </>
            }
            checked={settings?.guestInvites?.enabled ?? false}
            busy={busy === 'guestInvites'}
            onChange={next => void setFlag('guestInvites', 'guest-invites', next, 'Guest invites')}
          />

          <SettingToggle
            id="sqlConsoleEnabled"
            icon={Terminal}
            label="Enable the read-only SQL console"
            consequence={
              <>
                Adds a query box to each app&apos;s Database tab. Writes are refused by the
                server and results are capped.{' '}
                <strong>
                  {settings?.sqlConsole?.catalogVisibility ??
                    'Any arbitrary query can read the shared PostgreSQL catalogs, which list every database and role on this server.'}
                </strong>{' '}
                Admin-only for that reason.
              </>
            }
            checked={settings?.sqlConsole?.enabled ?? false}
            busy={busy === 'sqlConsole'}
            onChange={next => void setFlag('sqlConsole', 'sql-console', next, 'SQL console')}
          />
        </div>
      </Card>

      <Card padded={false} className="mb-6">
        <div className="flex items-center gap-2 border-b px-4 py-3 border-line">
          <Mail className="h-4 w-4 text-faint" aria-hidden="true" />
          <h2 className="font-semibold text-fg">Outbound mail</h2>
          <span className="ml-auto text-xs text-muted">
            {mail?.credentialConfigured ? 'Password set' : 'No password set'}
          </span>
        </div>
        <div className="space-y-4 p-4">
          <p className="text-xs leading-relaxed text-muted">
            The SMTP relay DROP sends from. Guest invitations and share notifications ride on it.
            Leave a field empty to clear it.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted">
              Host
              <Input
                value={mailDraft.host}
                onChange={e => setMailDraft(d => ({ ...d, host: e.target.value }))}
                placeholder="smtp.example.com"
                className="mt-1"
              />
            </label>
            <label className="text-xs font-semibold text-muted">
              Port
              <Input
                value={mailDraft.port}
                onChange={e => setMailDraft(d => ({ ...d, port: e.target.value }))}
                placeholder="587"
                inputMode="numeric"
                className="mt-1"
              />
            </label>
            <label className="text-xs font-semibold text-muted">
              Username
              <Input
                value={mailDraft.user}
                onChange={e => setMailDraft(d => ({ ...d, user: e.target.value }))}
                placeholder="postmaster@example.com"
                className="mt-1"
              />
            </label>
            <label className="text-xs font-semibold text-muted">
              From address
              <Input
                value={mailDraft.from}
                onChange={e => setMailDraft(d => ({ ...d, from: e.target.value }))}
                placeholder="drop@example.com"
                className="mt-1"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="mailSecure"
              checked={mailDraft.secure}
              onChange={e => setMailDraft(d => ({ ...d, secure: e.target.checked }))}
              className="h-4 w-4 rounded accent-accent"
            />
            <label htmlFor="mailSecure" className="text-sm text-fg">
              Use TLS on connect (usually port 465)
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => void saveMail()} disabled={busy !== ''}>
              {busy === 'mail' ? 'Saving…' : 'Save relay settings'}
            </Button>
            <span className="text-xs text-muted">
              Changing the host clears the stored password.
            </span>
          </div>

          <hr className="border-line" />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted">
              Relay password
              {/* Write-only by design: the API reports whether a credential
                  exists and never what it is, so this box is always empty on
                  load rather than showing a placeholder that implies a value. */}
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={mail?.credentialConfigured ? 'Set — enter a new one to replace' : 'Not set'}
                autoComplete="new-password"
                className="mt-1"
              />
            </label>
            <div className="flex items-end">
              <Button
                onClick={() => void saveCredential()}
                disabled={busy !== '' || password === ''}
              >
                {busy === 'credential' ? 'Saving…' : 'Save password'}
              </Button>
            </div>
          </div>

          <hr className="border-line" />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-muted">
              Send a test message to
              <Input
                value={testTo}
                onChange={e => setTestTo(e.target.value)}
                placeholder="you@example.com"
                className="mt-1"
              />
            </label>
            <div className="flex items-end">
              <Button
                variant="secondary"
                onClick={() => void sendTest()}
                disabled={busy !== '' || testTo.trim() === ''}
              >
                {busy === 'test' ? 'Sending…' : 'Send test'}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">
            This dials the real relay, so it is rate-limited separately from the rest of the API.
          </p>
        </div>
      </Card>
    </>
  );
}

export default PlatformSettingsTab;
