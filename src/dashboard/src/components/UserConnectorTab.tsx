import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import { apiJsonWithStatus, CONNECTORS_DISABLED_REASON } from '../api/client';
import Card from './ui/Card';
import Button from './ui/Button';
import ConnectorDetailsPanel, { ConnectorDetails } from './ConnectorDetailsPanel';

/**
 * Non-admin Settings panel for the claude.ai (web) MCP connector (multi-user
 * MCP connectors). Reads the already-minted client_id from the read-only
 * GET /api/v1/oauth/connector-info — unlike the admin tab (McpConnectorTab)
 * this NEVER mints; POST /oauth/client stays the only minting path and stays
 * admin-only. Renders the shared ConnectorDetailsPanel on success, or one of
 * several actionable states instead of a generic error:
 *  - 403 ("UNAUTHORIZED") with `details.reason === 'connectors_disabled'`:
 *    the admin toggle is off.
 *  - 403 ("UNAUTHORIZED") without that reason: an unrelated permission
 *    problem (e.g. a `readonly` account) — the same status+code pair as the
 *    line above, since there is deliberately no FORBIDDEN code, so the
 *    "ask an administrator to turn it on" copy would be actively wrong here.
 *  - 503: the server has no Public URL configured yet.
 *  - 404: an admin has never minted the client_id.
 *  - status 0 (fetch rejected, or a response that failed to parse): a
 *    network error — surfaced with Retry rather than a stuck spinner.
 * apiJson is deliberately NOT used here — it discards the HTTP status, which
 * the 403 disambiguation above needs. apiJsonWithStatus keeps apiJson's
 * network-error handling.
 */

type PanelState =
  | { kind: 'loading' }
  | { kind: 'ready'; details: ConnectorDetails }
  | { kind: 'disabled' }
  | { kind: 'forbidden' }
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
    const res = await apiJsonWithStatus<ConnectorDetails>('/oauth/connector-info');

    // status 0: apiJsonWithStatus's fetch rejected (or the response failed to
    // parse) — there is no HTTP status to discriminate on, just report it.
    if (res.status === 0) {
      setState({ kind: 'error', message: res.error?.message ?? 'Failed to load connector details.' });
      return;
    }

    // 403 with code UNAUTHORIZED is shared by the connector-policy gate AND a
    // plain insufficient-role rejection (authMiddleware) — there is
    // deliberately no FORBIDDEN code. `details.reason` is the only reliable
    // discriminator (connector-policy.ts); a 401 handles "no credential" and
    // MUST_CHANGE_PASSWORD is its own code, so neither collides here.
    if (res.status === 403 && res.error?.code === 'UNAUTHORIZED') {
      const details = res.error.details as { reason?: string } | undefined;
      if (details?.reason === CONNECTORS_DISABLED_REASON) {
        setState({ kind: 'disabled' });
      } else {
        setState({ kind: 'forbidden' });
      }
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
    if (res.success && res.data) {
      setState({ kind: 'ready', details: res.data });
      return;
    }
    setState({ kind: 'error', message: res.error?.message ?? 'Failed to load connector details.' });
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

        {/* A 403/UNAUTHORIZED that is NOT the policy toggle — e.g. a
            `readonly` account. Never the "ask an administrator to turn it
            on" copy above: no toggle would fix this. */}
        {state.kind === 'forbidden' && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={noticeBoxStyle}>
            Your account does not have permission to set this up.
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
