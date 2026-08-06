import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import Button from './ui/Button';
import Input from './ui/Input';
import ConnectorDetailsPanel, { ConnectorDetails } from './ConnectorDetailsPanel';

/**
 * Admin-only Settings panel that surfaces the claude.ai (web) MCP connector
 * details (PRD-041). Reads the per-server OAuth Client ID + MCP URL from
 * POST /api/v1/oauth/client (idempotent create-or-return), so an admin can
 * copy them into claude.ai's custom-connector dialog instead of curling. The
 * endpoint fails closed (503) until DROP_PUBLIC_URL is set on the server.
 * This is the only minting path in the product — the non-admin panel
 * (UserConnectorTab) reads the already-minted client_id read-only.
 *
 * Also lets the admin set/edit the server's Public URL (DROP_PUBLIC_URL) and
 * the non-admin connector-setup toggle directly from the UI via
 * GET/PUT /api/v1/admin/settings — no restart required.
 */

interface AdminSettings {
  publicUrl: string | null;
  source: 'stored' | 'env' | 'unset';
  storedPublicUrl: string | null;
  // Optional, not required: PUT /admin/settings/public-url's response
  // (buildSettingsPayload) deliberately does NOT carry this field (Item 2 —
  // it's shared with a second endpoint's shape), so a naive `setSettings` of
  // that response would blank it out. GET /admin/settings and
  // PUT /admin/settings/user-connectors are the only responses that set it.
  userConnectors?: { enabled: boolean };
}

/** Shape actually returned by PUT /admin/settings/public-url — no userConnectors. */
type PublicUrlSettings = Omit<AdminSettings, 'userConnectors'>;

function PublicUrlSection({
  value,
  onChange,
  onSave,
  saving,
  disabled,
  error,
  source,
  prominent,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  /** True while a DIFFERENT save (the connectors toggle) is in flight — cross-disables this section's controls so the two read-modify-write settings writes can't race. */
  disabled: boolean;
  error: string | null;
  source: AdminSettings['source'];
  /** Style as the primary call-to-action (unconfigured state). */
  prominent: boolean;
}): JSX.Element {
  return (
    <div
      className={prominent ? 'rounded-lg border p-4' : ''}
      style={
        prominent
          ? { borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'var(--bg-2)' }
          : undefined
      }
    >
      <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--text)' }}>
        Public URL
      </h3>
      <p className="mb-2 text-xs" style={{ color: 'var(--text-3)', lineHeight: 1.6 }}>
        The public HTTPS origin this DROP server is reachable at &mdash; required for the claude.ai
        connector to work.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex-1">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://drop.example.com"
            error={error ?? undefined}
            disabled={disabled}
          />
        </div>
        <Button onClick={onSave} loading={saving} disabled={saving || disabled}>
          Save
        </Button>
      </div>
      {source === 'env' && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-3)', lineHeight: 1.6 }}>
          Currently set from the{' '}
          <code style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>DROP_PUBLIC_URL</code>{' '}
          environment variable. Saving here overrides it.
        </p>
      )}
      <p className="mt-2 text-xs" style={{ color: 'var(--warn)', lineHeight: 1.6 }}>
        Changing this changes the OAuth issuer &mdash; anyone already connected in claude.ai will
        need to reconnect.
      </p>
    </div>
  );
}

export default function McpConnectorTab(): JSX.Element {
  const { toast } = useToast();
  const [details, setDetails] = useState<ConnectorDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [urlInput, setUrlInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingConnectors, setSavingConnectors] = useState(false);

  // Cross-disable the two settings writers: SettingsManager setters are
  // read-modify-write, so a Public URL save racing the connectors-toggle save
  // can silently drop one field even though both requests return 200.
  const busy = saving || savingConnectors;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    const json = await apiJson<ConnectorDetails>('/oauth/client', { method: 'POST' });
    if (json.success && json.data) {
      setDetails(json.data);
    } else {
      const msg = json.error?.message ?? 'Failed to load connector details.';
      // 503 when DROP_PUBLIC_URL is unset — treat as setup guidance, not an error.
      if (/not configured/i.test(msg)) setNotConfigured(true);
      else setError(msg);
    }
    setLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    const json = await apiJson<AdminSettings>('/admin/settings');
    if (json.success && json.data) {
      setSettings(json.data);
      setUrlInput(json.data.publicUrl ?? '');
    } else {
      toast('error', json.error?.message ?? 'Failed to load current settings.');
    }
    setSettingsLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
    void loadSettings();
    // Only run on mount — load()/loadSettings() are re-invoked explicitly
    // (retry button, after a successful save), not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savePublicUrl = async () => {
    setSaving(true);
    setSaveError(null);
    const trimmed = urlInput.trim();
    const payload = { publicUrl: trimmed === '' ? null : trimmed };
    const json = await apiJson<PublicUrlSettings>(
      '/admin/settings/public-url',
      { method: 'PUT', ...jsonBody(payload) }
    );
    if (json.success && json.data) {
      // Merge, don't replace — this response has no userConnectors field, and
      // a bare setSettings(json.data) would blank the toggle's state out from
      // under the checkbox (settings.userConnectors.enabled would throw).
      setSettings(prev => ({ ...json.data!, userConnectors: prev?.userConnectors }));
      setUrlInput(json.data.publicUrl ?? '');
      toast('success', json.data.publicUrl ? 'Public URL saved' : 'Public URL cleared');
      // Refresh the connector details now that the public URL (and thus the
      // OAuth issuer) may have changed.
      void load();
    } else {
      const msg = json.error?.message ?? 'Failed to save public URL.';
      setSaveError(msg);
      toast('error', msg);
    }
    setSaving(false);
  };

  const setConnectorsEnabled = async (enabled: boolean) => {
    setSavingConnectors(true);
    const json = await apiJson<{ enabled: boolean }>(
      '/admin/settings/user-connectors',
      { method: 'PUT', ...jsonBody({ enabled }) }
    );
    if (json.success && json.data) {
      setSettings(prev => (prev ? { ...prev, userConnectors: json.data! } : prev));
      toast('success', json.data.enabled ? 'Non-admin connectors enabled' : 'Non-admin connectors disabled');
    } else {
      toast('error', json.error?.message ?? 'Failed to update the setting.');
    }
    setSavingConnectors(false);
  };

  return (
    <Card padded={false} className="mb-6">
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        <Plug className="h-4 w-4" style={{ color: 'var(--text-3)' }} />
        <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
          Claude (MCP) connector
        </h2>
      </div>

      <div className="space-y-4 p-4">
        <p className="text-sm" style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>
          Let <strong style={{ color: 'var(--text)' }}>claude.ai</strong> deploy and manage apps
          through the hosted MCP server. Add a custom connector in claude.ai with the values below
          &mdash; each person signs in and consents, and only ever sees their own apps.
        </p>

        {(loading || settingsLoading) && (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>
            Loading connector details&hellip;
          </p>
        )}

        {!loading && !settingsLoading && notConfigured && (
          <div
            className="rounded-lg border px-4 py-3 text-sm"
            style={{
              borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)',
              background: 'var(--bg-2)',
              color: 'var(--text-2)',
              lineHeight: 1.7,
            }}
          >
            The web connector is not configured yet. Set the Public URL below and save to enable it
            &mdash; no restart required. (You can also set the{' '}
            <code style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>DROP_PUBLIC_URL</code>{' '}
            environment variable and restart DROP instead.)
          </div>
        )}

        {!settingsLoading && (
          <PublicUrlSection
            value={urlInput}
            onChange={setUrlInput}
            onSave={() => void savePublicUrl()}
            saving={saving}
            disabled={savingConnectors}
            error={saveError}
            source={settings?.source ?? 'unset'}
            prominent={notConfigured}
          />
        )}

        {!settingsLoading && (
          <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="userConnectorsEnabled"
                checked={settings?.userConnectors?.enabled ?? true}
                onChange={e => void setConnectorsEnabled(e.target.checked)}
                className="h-4 w-4 rounded"
                style={{ accentColor: 'var(--accent)' }}
                disabled={busy}
              />
              <label
                htmlFor="userConnectorsEnabled"
                className="text-sm font-semibold"
                style={{ color: 'var(--text)' }}
              >
                Let non-admin users set up their own claude.ai connector
              </label>
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-3)', lineHeight: 1.6 }}>
              Turning this off disables <strong>claude.ai connector setup</strong> for non-admin
              accounts only &mdash; it does not disable agent tokens or{' '}
              <code style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>POST /api/v1/mcp</code>,
              which any user can still drive from Claude Code. It also stops non-admin users' own{' '}
              <code style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>mcp: auth: drop</code>{' '}
              tenant apps from refreshing their tokens (symptom: a 401 from the gateway).
            </p>
          </div>
        )}

        {!loading && !settingsLoading && error && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--err)' }}>
              {error}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        )}

        {!loading && !settingsLoading && details && <ConnectorDetailsPanel details={details} />}
      </div>
    </Card>
  );
}
