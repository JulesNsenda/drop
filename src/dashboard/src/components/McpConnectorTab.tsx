import { useCallback, useEffect, useState } from 'react';
import { Plug, Copy, RefreshCw } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import Button from './ui/Button';
import Input from './ui/Input';

/**
 * Admin-only Settings panel that surfaces the claude.ai (web) MCP connector
 * details (PRD-041). Reads the per-server OAuth Client ID + MCP URL from
 * POST /api/v1/oauth/client (idempotent create-or-return), so an admin can
 * copy them into claude.ai's custom-connector dialog instead of curling. The
 * endpoint fails closed (503) until DROP_PUBLIC_URL is set on the server.
 *
 * Also lets the admin set/edit the server's Public URL (DROP_PUBLIC_URL)
 * directly from the UI via GET/PUT /api/v1/admin/settings — no restart
 * required — since that's the prerequisite for the connector to work at all.
 */

interface ConnectorDetails {
  client_id: string;
  client_secret: string | null;
  redirect_uri: string;
  mcp_url: string;
}

interface AdminSettings {
  publicUrl: string | null;
  source: 'stored' | 'env' | 'unset';
  storedPublicUrl: string | null;
}

const labelStyle = { color: 'var(--text-3)', letterSpacing: 0.5 } as const;
const valueBoxStyle = { borderColor: 'var(--border)', background: 'var(--bg-2)' } as const;

function CopyField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase" style={labelStyle}>
        {label}
      </div>
      <div
        className="flex items-center gap-2 rounded-lg border px-3 py-2"
        style={valueBoxStyle}
      >
        <code
          className="flex-1 truncate text-sm"
          style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="shrink-0"
          style={{ color: 'var(--text-3)', cursor: 'pointer' }}
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PublicUrlSection({
  value,
  onChange,
  onSave,
  saving,
  error,
  source,
  prominent,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
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
          />
        </div>
        <Button onClick={onSave} loading={saving} disabled={saving}>
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

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast('success', `${what} copied`);
    } catch {
      toast('error', 'Could not copy — select and copy manually');
    }
  };

  const savePublicUrl = async () => {
    setSaving(true);
    setSaveError(null);
    const trimmed = urlInput.trim();
    const payload = { publicUrl: trimmed === '' ? null : trimmed };
    const json = await apiJson<AdminSettings>(
      '/admin/settings/public-url',
      { method: 'PUT', ...jsonBody(payload) }
    );
    if (json.success && json.data) {
      setSettings(json.data);
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
            error={saveError}
            source={settings?.source ?? 'unset'}
            prominent={notConfigured}
          />
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

        {!loading && !settingsLoading && details && (
          <>
            <div className="grid gap-3">
              <CopyField
                label="MCP Server URL"
                value={details.mcp_url}
                onCopy={() => void copy(details.mcp_url, 'MCP Server URL')}
              />
              <CopyField
                label="OAuth Client ID"
                value={details.client_id}
                onCopy={() => void copy(details.client_id, 'Client ID')}
              />
              <div>
                <div className="mb-1 text-xs font-medium uppercase" style={labelStyle}>
                  OAuth Client Secret
                </div>
                <div
                  className="rounded-lg border px-3 py-2 text-sm"
                  style={{ ...valueBoxStyle, color: 'var(--text-2)' }}
                >
                  Leave blank &mdash; DROP uses PKCE, so there is no client secret.
                </div>
              </div>
            </div>

            <p className="text-xs" style={{ color: 'var(--text-3)', lineHeight: 1.6 }}>
              The Client ID is not a secret &mdash; share it with anyone who should connect. It is the
              same for this whole server and stays stable across restarts.
            </p>

            <div>
              <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--text)' }}>
                Set it up in claude.ai
              </h3>
              <ol
                className="space-y-1 pl-5 text-sm"
                style={{ color: 'var(--text-2)', lineHeight: 1.7, listStyleType: 'decimal' }}
              >
                <li>Open Settings &rarr; Connectors &rarr; Add custom connector.</li>
                <li>Paste the MCP Server URL and Client ID above; leave the secret blank.</li>
                <li>Click Connect, sign in to DROP, and approve access.</li>
              </ol>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
