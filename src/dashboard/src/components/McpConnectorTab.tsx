import { useCallback, useEffect, useState } from 'react';
import { Plug, Copy, RefreshCw } from 'lucide-react';
import { apiJson } from '../api/client';
import { useToast } from './Toast';
import Card from './ui/Card';
import Button from './ui/Button';

/**
 * Admin-only Settings panel that surfaces the claude.ai (web) MCP connector
 * details (PRD-041). Reads the per-server OAuth Client ID + MCP URL from
 * POST /api/v1/oauth/client (idempotent create-or-return), so an admin can
 * copy them into claude.ai's custom-connector dialog instead of curling. The
 * endpoint fails closed (503) until DROP_PUBLIC_URL is set on the server —
 * surfaced here as setup guidance rather than a raw error.
 */

interface ConnectorDetails {
  client_id: string;
  client_secret: string | null;
  redirect_uri: string;
  mcp_url: string;
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

export default function McpConnectorTab(): JSX.Element {
  const { toast } = useToast();
  const [details, setDetails] = useState<ConnectorDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast('success', `${what} copied`);
    } catch {
      toast('error', 'Could not copy — select and copy manually');
    }
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

        {loading && (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>
            Loading connector details&hellip;
          </p>
        )}

        {!loading && notConfigured && (
          <div
            className="rounded-lg border px-4 py-3 text-sm"
            style={{
              borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)',
              background: 'var(--bg-2)',
              color: 'var(--text-2)',
              lineHeight: 1.7,
            }}
          >
            The web connector is not configured yet. Set{' '}
            <code style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>DROP_PUBLIC_URL</code> to
            the public HTTPS origin of this server (for example{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>https://drop.example.com</code>) and restart
            DROP, then reopen this tab.
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--err)' }}>
              {error}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        )}

        {!loading && details && (
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
