import { useCallback, useEffect, useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, Copy, RefreshCw, AlertTriangle, CheckCircle, KeyRound, Trash2 } from 'lucide-react';
import { apiJson, jsonBody } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import Button from './ui/Button';
import Input from './ui/Input';
import Card from './ui/Card';
import Badge, { BadgeTone } from './ui/Badge';

/**
 * Admin-only Settings panel for the GitHub webhook HMAC secret (PRD-061-ish /
 * DROP-061). Lets an admin generate (or paste) the secret DROP uses to verify
 * `POST /api/v1/git/webhook` deliveries, and copy the payload URL + short
 * GitHub-form hints straight into GitHub's webhook setup — no SSH session, no
 * restart. `DROP_GITHUB_WEBHOOK_SECRET` remains a supported fallback; the
 * stored (dashboard) value always takes precedence when both are present.
 */

type WebhookSource = 'stored' | 'env' | 'unset';

interface GithubWebhookStatus {
  configured: boolean;
  source: WebhookSource;
  payloadUrl: string | null;
}

interface AdminSettingsResponse {
  githubWebhook: GithubWebhookStatus;
}

interface GenerateSecretResponse {
  secret: string;
}

type Step = 'idle' | 'custom-form' | 'reveal';

const STATUS_LABEL: Record<WebhookSource, string> = {
  stored: 'Configured (dashboard)',
  env: 'Configured (environment variable)',
  unset: 'Not configured',
};

const STATUS_TONE: Record<WebhookSource, BadgeTone> = {
  stored: 'ok',
  env: 'accent',
  unset: 'warn',
};

function GitWebhooksTab() {
  const { toast } = useToast();
  const confirmDialog = useConfirm();

  const [status, setStatus] = useState<GithubWebhookStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');

  const [step, setStep] = useState<Step>('idle');
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const [customSecret, setCustomSecret] = useState('');
  const [customError, setCustomError] = useState('');
  const [settingCustom, setSettingCustom] = useState(false);

  const [clearing, setClearing] = useState(false);

  /** Cross-disable the three idle actions (+ the custom-form submit): while
   * any one mutation is in flight, the others must not be clickable — e.g.
   * Clear firing while Generate is still in flight could wipe the
   * freshly-generated secret out from under the admin before they've copied
   * it, leaving them about to paste a dead secret into GitHub. */
  const busy = generating || settingCustom || clearing;

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError('');
    const json = await apiJson<AdminSettingsResponse>('/admin/settings');
    if (json.success && json.data) {
      setStatus(json.data.githubWebhook);
    } else {
      setStatusError(json.error?.message || 'Failed to load webhook settings');
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const payloadUrl = status?.payloadUrl ?? `${window.location.origin}/api/v1/git/webhook`;

  /** Same confirm rule for both generate and "use my own secret": warn when a
   * secret is already in effect (new one breaks existing deliveries until
   * updated), plus an extra posture note when the current source is the env
   * var (setting here moves it on-disk and the stored value starts winning). */
  const confirmSecretChange = async (): Promise<boolean> => {
    if (!status?.configured) return true;
    let message = 'Existing GitHub webhooks will fail until you update them with the new secret.';
    if (status.source === 'env') {
      message +=
        " This also moves the secret from the environment variable into DROP's settings — the stored value will take precedence from now on.";
    }
    return confirmDialog({
      title: 'Replace webhook secret?',
      message,
      confirmText: 'Replace secret',
      variant: 'danger',
    });
  };

  const handleGenerate = async () => {
    if (busy) return;
    const ok = await confirmSecretChange();
    if (!ok) return;
    setGenerating(true);
    const json = await apiJson<GenerateSecretResponse>(
      '/admin/settings/github-webhook-secret/generate',
      { method: 'POST' }
    );
    setGenerating(false);
    if (json.success && json.data) {
      setRevealedSecret(json.data.secret);
      setStep('reveal');
      void fetchStatus();
    } else {
      toast('error', json.error?.message || 'Failed to generate secret');
    }
  };

  const handleCopySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      toast('success', 'Secret copied to clipboard');
    } catch {
      toast('error', 'Could not copy automatically — select and copy the secret manually');
    }
  };

  const handleDoneReveal = () => {
    setRevealedSecret(null);
    setStep('idle');
  };

  const handleCopyPayloadUrl = async () => {
    try {
      await navigator.clipboard.writeText(payloadUrl);
      toast('success', 'Payload URL copied to clipboard');
    } catch {
      toast('error', 'Could not copy automatically — select and copy the URL manually');
    }
  };

  const handleOpenCustomForm = () => {
    if (busy) return;
    setCustomSecret('');
    setCustomError('');
    setStep('custom-form');
  };

  const handleCancelCustomForm = () => {
    setCustomSecret('');
    setCustomError('');
    setStep('idle');
  };

  const handleSetCustom = async (e: FormEvent) => {
    e.preventDefault();
    setCustomError('');

    const trimmed = customSecret.trim();
    if (!trimmed) {
      setCustomError('Secret is required — use Clear secret to remove it instead');
      return;
    }

    const ok = await confirmSecretChange();
    if (!ok) return;

    setSettingCustom(true);
    const json = await apiJson('/admin/settings/github-webhook-secret', {
      method: 'PUT',
      ...jsonBody({ secret: trimmed }),
    });
    setSettingCustom(false);

    if (json.success) {
      toast('success', 'Webhook secret updated');
      setCustomSecret('');
      setStep('idle');
      void fetchStatus();
    } else {
      setCustomError(json.error?.message || 'Failed to set secret');
    }
  };

  const handleClear = async () => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: 'Clear webhook secret',
      message:
        'Clear the stored webhook secret? GitHub deliveries will fail until a new one is configured (the environment variable, if set, will take over automatically).',
      confirmText: 'Clear secret',
      variant: 'danger',
    });
    if (!confirmed) return;

    setClearing(true);
    const json = await apiJson('/admin/settings/github-webhook-secret', {
      method: 'PUT',
      ...jsonBody({ secret: null }),
    });
    setClearing(false);

    if (json.success) {
      toast('success', 'Webhook secret cleared');
      void fetchStatus();
    } else {
      toast('error', json.error?.message || 'Failed to clear secret');
    }
  };

  return (
    <Card padded={false} className="mb-6">
      <div
        className="px-4 py-3 border-b flex items-center gap-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <GitBranch className="w-4 h-4" style={{ color: 'var(--text-2)' }} />
        <h2 className="font-semibold" style={{ color: 'var(--text)' }}>
          Git webhooks
        </h2>
      </div>

      <div className="p-4 space-y-4">
        <p className="text-sm" style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>
          GitHub signs each webhook delivery with this secret so DROP can verify a push actually
          came from GitHub before triggering an auto-redeploy.
        </p>

        {/*
         * The reveal-once panel and the "use my own secret" form are rendered
         * OUTSIDE the loading/error/status ternary below, and gated only on
         * `step` — not on `statusLoading`/`statusError`. Both handlers below
         * trigger a `fetchStatus()` refresh right after a successful mutation
         * (per plan: "after any mutation, refresh the status from GET"); if
         * that refresh were allowed to flip this section into its skeleton or
         * error branch, it would unmount the just-generated secret before the
         * admin has a chance to copy it — or lose it for good if the refetch
         * itself fails. Mirrors ApiKeysTab's reveal panel placement.
         */}

        {/* Reveal-once panel (after Generate) */}
        {step === 'reveal' && revealedSecret && (
          <div
            className="max-w-md space-y-3 rounded-lg border p-4"
            style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-2" style={{ color: 'var(--warn)' }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <p className="text-sm font-medium">
                You won't see this again — paste it into GitHub now.
              </p>
            </div>
            <code
              className="block break-all select-all rounded border px-3 py-2 font-mono text-xs"
              style={{
                background: 'var(--bg-3)',
                color: 'var(--text)',
                borderColor: 'var(--border)',
              }}
            >
              {revealedSecret}
            </code>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={() => void handleCopySecret()}>
                <Copy className="w-4 h-4" />
                Copy
              </Button>
              <Button type="button" onClick={handleDoneReveal}>
                <CheckCircle className="w-4 h-4" />
                Done
              </Button>
            </div>
          </div>
        )}

        {/* "Use my own secret" form */}
        {step === 'custom-form' && (
          <form
            onSubmit={handleSetCustom}
            className="max-w-md space-y-3 rounded-lg border p-4"
            style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
          >
            <Input
              id="custom-webhook-secret"
              label="Secret"
              type="password"
              value={customSecret}
              onChange={e => setCustomSecret(e.target.value)}
              placeholder="8-256 printable characters"
              error={customError || undefined}
              autoFocus
            />
            <div className="flex gap-3">
              <Button type="submit" loading={settingCustom} disabled={busy}>
                {settingCustom ? 'Saving...' : 'Save secret'}
              </Button>
              <Button type="button" variant="secondary" onClick={handleCancelCustomForm}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {/*
         * Status badge + payload URL + hints + idle actions. `statusLoading`/
         * `statusError` only gate the FIRST load (`!status`) — once `status`
         * has loaded once it stays truthy across background refetches (it's
         * only overwritten on a successful GET), so this section shows the
         * last-known status instead of flashing to a skeleton on every
         * post-mutation refresh.
         */}
        {statusLoading && !status ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 w-48 rounded" style={{ background: 'var(--border-2)' }} />
            <div className="h-4 w-64 rounded" style={{ background: 'var(--border-2)' }} />
          </div>
        ) : statusError && !status ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--err)' }}>
              {statusError}
            </p>
            <Button variant="secondary" onClick={() => void fetchStatus()}>
              <RefreshCw className="w-4 h-4" />
              Retry
            </Button>
          </div>
        ) : status ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>
                Status:
              </span>
              <Badge tone={STATUS_TONE[status.source]}>{STATUS_LABEL[status.source]}</Badge>
            </div>

            {/* Payload URL */}
            <div>
              <div
                className="mb-1 text-xs font-medium uppercase"
                style={{ color: 'var(--text-3)', letterSpacing: 0.5 }}
              >
                Payload URL
              </div>
              <div
                className="flex items-center gap-2 rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
              >
                <code
                  className="flex-1 truncate text-sm font-mono"
                  style={{ color: 'var(--text)' }}
                >
                  {payloadUrl}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyPayloadUrl()}
                  aria-label="Copy payload URL"
                  className="shrink-0"
                  style={{ color: 'var(--text-3)', cursor: 'pointer' }}
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
              {!status.payloadUrl && (
                <p className="mt-1 text-xs" style={{ color: 'var(--text-3)', lineHeight: 1.6 }}>
                  This is a best guess based on your browser's address. Set the platform's Public
                  URL in{' '}
                  <Link to="/settings?tab=mcp-connector" className="underline">
                    Settings &rarr; Claude (MCP)
                  </Link>{' '}
                  so DROP can report the exact payload URL — especially important behind a reverse
                  proxy.
                </p>
              )}
            </div>

            {/* GitHub form hints */}
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-2)',
                color: 'var(--text-2)',
                lineHeight: 1.6,
              }}
            >
              In GitHub's webhook form: set <strong>Content type</strong> to{' '}
              <code className="font-mono">application/json</code>, subscribe to just the{' '}
              <strong>push</strong> event, and paste the secret below into the{' '}
              <strong>Secret</strong> field.
            </div>

            {/* Actions */}
            {step === 'idle' && (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void handleGenerate()} loading={generating} disabled={busy}>
                  {generating ? 'Generating...' : 'Generate secret'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleOpenCustomForm}
                  disabled={busy}
                >
                  <KeyRound className="w-4 h-4" />
                  Use my own secret
                </Button>
                {status.source === 'stored' && (
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void handleClear()}
                    loading={clearing}
                    disabled={busy}
                  >
                    <Trash2 className="w-4 h-4" />
                    {clearing ? 'Clearing...' : 'Clear secret'}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}

export default GitWebhooksTab;
