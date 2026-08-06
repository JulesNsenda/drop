import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { apiFetch } from '../api/client';
import Card from './ui/Card';
import Button from './ui/Button';
import ConnectorDetailsPanel, { ConnectorDetails } from './ConnectorDetailsPanel';

/**
 * Non-admin Settings panel for the claude.ai (web) MCP connector (multi-user
 * MCP connectors). Reads the already-minted client_id from the read-only
 * GET /api/v1/oauth/connector-info — unlike the admin tab (McpConnectorTab)
 * this NEVER mints; POST /oauth/client stays the only minting path and stays
 * admin-only. Renders the shared ConnectorDetailsPanel on success, or one of
 * three actionable states instead of a generic error:
 *  - 403 ("UNAUTHORIZED"): connectors disabled by the admin toggle.
 *  - 503: the server has no Public URL configured yet.
 *  - 404: an admin has never minted the client_id.
 * apiJson is deliberately NOT used here — it discards the HTTP status, and
 * the 403 above shares its error CODE with the 401 "no credential" case, so
 * status is the only reliable discriminator.
 */

type PanelState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: ConnectorDetails }
  | { kind: 'disabled' }
  | { kind: 'not-configured' }
  | { kind: 'not-ready' }
  | { kind: 'error'; message: string };

const noticeBoxStyle = {
  borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)',
  background: 'var(--bg-2)',
  color: 'var(--text-2)',
  lineHeight: 1.7,
} as const;

export default function UserConnectorTab(): JSX.Element {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await apiFetch('/oauth/connector-info');
    let body: { success?: boolean; data?: ConnectorDetails; error?: { code?: string; message?: string } };
    try {
      body = await res.json();
    } catch {
      setState({ kind: 'error', message: 'Failed to load connector details.' });
      return;
    }

    // 403 with code UNAUTHORIZED is the connector-policy gate specifically
    // (server.ts pairs that code with this status only for the toggle — a
    // 401 handles "no credential" and MUST_CHANGE_PASSWORD is its own code).
    if (res.status === 403 && body.error?.code === 'UNAUTHORIZED') {
      setState({ kind: 'disabled' });
      return;
    }
    if (res.status === 503) {
      setState({ kind: 'not-configured' });
      return;
    }
    if (res.status === 404) {
      setState({ kind: 'not-ready' });
      return;
    }
    if (body.success && body.data) {
      setState({ kind: 'ready', details: body.data });
      return;
    }
    setState({ kind: 'error', message: body.error?.message ?? 'Failed to load connector details.' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
          Let <strong style={{ color: 'var(--text)' }}>claude.ai</strong> deploy and manage your own
          apps through the hosted MCP server. Add a custom connector in claude.ai with the values
          below &mdash; you sign in and consent, and only ever see your own apps.
        </p>

        {state.kind === 'loading' && (
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>
            Loading connector details&hellip;
          </p>
        )}

        {state.kind === 'disabled' && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={noticeBoxStyle}>
            MCP connectors are disabled by your administrator on this server.
          </div>
        )}

        {state.kind === 'not-configured' && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={noticeBoxStyle}>
            The web connector is not configured yet &mdash; ask an administrator to set the
            server's Public URL in Settings.
          </div>
        )}

        {state.kind === 'not-ready' && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={noticeBoxStyle}>
            An administrator must finish connector setup first &mdash; ask them to open Settings
            &rarr; Claude (MCP).
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--err)' }}>
              {state.message}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
          </div>
        )}

        {state.kind === 'ready' && <ConnectorDetailsPanel details={state.details} />}
      </div>
    </Card>
  );
}
