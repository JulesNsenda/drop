import { useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiFetch, jsonBody } from '../api/client';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';

/** OAuth 2.1 authorize params forwarded by the backend's redirect (PRD-041). */
interface OAuthParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
}

/**
 * Standalone OAuth consent screen (PRD-041 / Phase 4).
 *
 * `GET /api/v1/oauth/authorize` 302s the browser here (real route
 * `/dashboard/oauth-consent`) with the authorize params as a query string.
 * This is a bare `AuthLayout` page — NOT wrapped in the sidebar `Layout` — and
 * self-manages auth: while loading it shows a spinner, while signed out it
 * bounces to `/login` carrying a `returnTo` so the operator lands back here
 * after signing in, and once authenticated it renders the consent card. On
 * approval it POSTs to `/api/v1/oauth/approve` and hands the browser off
 * (`window.location.href`, not react-router — the target is claude.ai, a
 * different origin) to the returned redirect.
 */
function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const auth = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Set only for the connector-policy 403 — a distinct, non-retryable state
  // (approving again cannot succeed while the toggle is off), so it replaces
  // the consent card instead of appearing as a dismissable inline error.
  const [disabledMessage, setDisabledMessage] = useState('');

  const params: OAuthParams = {
    client_id: searchParams.get('client_id') || '',
    redirect_uri: searchParams.get('redirect_uri') || '',
    state: searchParams.get('state') || '',
    code_challenge: searchParams.get('code_challenge') || '',
    code_challenge_method: searchParams.get('code_challenge_method') || '',
    scope: searchParams.get('scope') || '',
    resource: searchParams.get('resource') || '',
  };

  /**
   * Present when the grant is scoped to ONE app's MCP endpoint rather than to
   * DROP's control plane. Set by /oauth/authorize after it resolves the
   * requested resource; the server re-resolves independently at /approve, so
   * this is display only and is never sent back as authority.
   */
  const appName = searchParams.get('app') || '';

  const isValid = params.client_id.length > 0 && params.redirect_uri.length > 0;

  const handleApprove = async () => {
    setPending(true);
    setError('');

    // Only send params that were actually present on the query string, so we
    // don't ship empty-string overrides for optional fields.
    const body: Partial<OAuthParams> = { client_id: params.client_id, redirect_uri: params.redirect_uri };
    if (params.state) body.state = params.state;
    if (params.code_challenge) body.code_challenge = params.code_challenge;
    if (params.code_challenge_method) body.code_challenge_method = params.code_challenge_method;
    if (params.scope) body.scope = params.scope;
    if (params.resource) body.resource = params.resource;

    // apiJson (used elsewhere) discards the HTTP status, and this 403 shares
    // its error CODE with the plain "no credential" 401 — status is the only
    // reliable way to tell "connectors disabled" apart from any other refusal.
    const res = await apiFetch('/oauth/approve', { method: 'POST', ...jsonBody(body) });
    let json: { success?: boolean; data?: { redirect: string }; error?: { code?: string; message?: string } };
    try {
      json = await res.json();
    } catch {
      json = {};
    }

    if (json.success && json.data?.redirect) {
      window.location.href = json.data.redirect;
      return;
    }

    if (res.status === 403 && json.error?.code === 'UNAUTHORIZED') {
      setDisabledMessage(
        json.error?.message || 'MCP connectors are disabled for non-admin accounts on this server.'
      );
      setPending(false);
      return;
    }

    setError(json.error?.message || 'Failed to authorize. Please try again.');
    setPending(false);
  };

  const handleDeny = () => {
    setPending(true);
    window.location.href = `${params.redirect_uri}?error=access_denied&state=${encodeURIComponent(params.state)}`;
  };

  // Invalid request — no client_id/redirect_uri to work with, so there's
  // nothing safe to approve or deny.
  if (!isValid) {
    return (
      <AuthLayout>
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
            Invalid authorization request
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
            This link is missing required parameters.
          </p>
        </div>
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 flex-shrink-0" style={{ color: 'var(--err)' }} aria-hidden="true" />
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              We couldn't find a valid <code>client_id</code> and <code>redirect_uri</code> in this request. Please
              restart the connection from claude.ai.
            </p>
          </div>
        </Card>
      </AuthLayout>
    );
  }

  // Connector-policy 403 from /approve — the admin toggle is off. Not
  // retryable (approving again cannot succeed), so this replaces the consent
  // card entirely rather than showing an inline error next to a live
  // Approve button that would just fail again.
  if (disabledMessage) {
    return (
      <AuthLayout>
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
            Connector setup disabled
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
            {disabledMessage}
          </p>
        </div>
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 flex-shrink-0" style={{ color: 'var(--err)' }} aria-hidden="true" />
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Ask an administrator to turn on non-admin connector setup in Settings, or connect using
              an agent token from Claude Code instead.
            </p>
          </div>
        </Card>
      </AuthLayout>
    );
  }

  if (auth.loading) {
    return (
      <AuthLayout>
        <div className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--text-2)' }} aria-hidden="true" />
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Loading...
          </p>
        </div>
      </AuthLayout>
    );
  }

  // Signed out — bounce to login, carrying this exact URL (path + validated
  // query string) so the operator returns here after signing in.
  if (auth.authRequired && !auth.authenticated) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search }} />;
  }

  return (
    <AuthLayout>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
          Authorize claude.ai
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          Review the access below before continuing.
        </p>
      </div>

      <Card>
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border px-3 py-2.5 text-sm"
            style={{
              background: 'color-mix(in srgb, var(--err) 15%, transparent)',
              borderColor: 'color-mix(in srgb, var(--err) 35%, transparent)',
              color: 'var(--err)',
            }}
          >
            {error}
          </div>
        )}

        <div className="mb-5 flex items-start gap-3">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'var(--bg-3)', border: '1px solid var(--border)' }}
          >
            <ShieldCheck className="h-5 w-5" style={{ color: 'var(--accent)' }} aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm" style={{ color: 'var(--text)' }}>
              <strong>claude.ai</strong> wants to connect to your DROP account
              {auth.username ? (
                <>
                  {' '}
                  as <strong>{auth.username}</strong>
                </>
              ) : null}
              .
            </p>
            {/*
              What is actually being granted. Without this the screen reads
              identically for a full control-plane grant and for a grant scoped
              to a single app — the approver could not tell them apart, which
              makes the audience separation invisible at the one moment a person
              is asked to agree to it.
            */}
            {appName ? (
              <p className="mt-2 text-sm" style={{ color: 'var(--text-2)' }}>
                This grants access to <strong>{appName}</strong> only — one app's MCP
                endpoint. It does <strong>not</strong> allow deploying or managing your
                other apps.
              </p>
            ) : (
              <p className="mt-2 text-sm" style={{ color: 'var(--text-2)' }}>
                This will allow claude.ai to deploy and manage your apps on your behalf.
              </p>
            )}
            {params.resource ? (
              <p className="mt-2 break-all font-mono text-xs" style={{ color: 'var(--text-3)' }}>
                {params.resource}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="primary" onClick={handleApprove} loading={pending} className="flex-1">
            {!pending && <Check className="h-4 w-4" aria-hidden="true" />}
            {pending ? 'Authorizing...' : 'Approve'}
          </Button>
          <Button type="button" variant="secondary" onClick={handleDeny} disabled={pending} className="flex-1">
            <X className="h-4 w-4" aria-hidden="true" />
            Deny
          </Button>
        </div>
      </Card>
    </AuthLayout>
  );
}

export default OAuthConsent;
