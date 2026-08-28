import { Copy } from 'lucide-react';
import { useToast } from './Toast';

/**
 * Setup instructions + copy fields for a claude.ai (web) MCP connector
 * (multi-user MCP connectors, PRD-041). Extracted out of McpConnectorTab so
 * the admin panel (POST /oauth/client, mints) and the non-admin panel
 * (GET /oauth/connector-info, read-only) render the exact same claude.ai
 * setup steps and client-secret note instead of two copies that drift —
 * only the fetch differs per caller. `CopyField` stays private to this file.
 *
 * Admin-bundle only: it imports `useToast` (Toast), which is admin-only —
 * never import this from `components/landing/` (DROP-070 bundle split).
 */

export interface ConnectorDetails {
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
          className="flex-1 truncate text-sm font-mono text-fg"
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

export default function ConnectorDetailsPanel({
  details,
}: {
  details: ConnectorDetails;
}): JSX.Element {
  const { toast } = useToast();

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast('success', `${what} copied`);
    } catch {
      toast('error', 'Could not copy — select and copy manually');
    }
  };

  return (
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
        <h3 className="mb-2 text-sm font-semibold text-fg">
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
  );
}
