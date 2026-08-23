import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiJsonWithStatus, jsonBody } from '../api/client';
import AuthLayout from '../components/AuthLayout';
import Card from '../components/ui/Card';

/**
 * The hop that makes the browser access gate work at all (DROP-152).
 *
 * DROP sets no cookies on its own host — the dashboard session is a bearer JWT
 * in `localStorage` — so the 302 that arrives here from
 * `GET /api/v1/app-access/authorize` carries no credential of any kind. Only
 * code running in the page can read the session and present it. That is
 * exactly why `OAuthConsent` exists for the OAuth flow, and this follows it.
 *
 * Unlike that page there is nothing to CONSENT to: the visitor is being let
 * into an application an administrator already decided they may open. So this
 * screen has no button on the happy path — it exchanges and moves on, and only
 * ever stops to say something went wrong. A confirmation step here would be a
 * click that can only be answered one way.
 */
function AppAccessConsent() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const auth = useAuth();
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  // The exchange must happen exactly once. React 18's StrictMode double-invokes
  // effects in development, and the code is single-use — a second call would
  // consume a code that was already spent and show the visitor a failure on a
  // flow that had actually succeeded.
  const started = useRef(false);

  const appName = searchParams.get('app') || '';
  const flow = searchParams.get('flow') || '';
  const returnPath = searchParams.get('return') || '/';

  useEffect(() => {
    if (auth.loading || !auth.authenticated) return;
    if (!appName || !flow) return;
    if (started.current) return;
    started.current = true;

    void (async () => {
      const res = await apiJsonWithStatus<{ redirectTo: string }>('/app-access/code', {
        method: 'POST',
        ...jsonBody({ app: appName, flow, return: returnPath }),
      });

      if (res.status === 403) {
        // Terminal. The verify hop would refuse this visitor too, so bouncing
        // them onward would put them in a redirect loop between the two.
        setRefused(true);
        return;
      }
      const redirectTo = res.success ? res.data?.redirectTo : undefined;
      if (!redirectTo) {
        setError('Could not complete sign-in for this application.');
        return;
      }
      // A different origin (the app's), so a full navigation rather than
      // react-router.
      window.location.href = redirectTo;
    })();
  }, [auth.loading, auth.authenticated, appName, flow, returnPath]);

  if (auth.loading) {
    return (
      <AuthLayout>
        <Card className="p-8 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        </Card>
      </AuthLayout>
    );
  }

  if (!auth.authenticated) {
    // Carry the whole current URL so the visitor lands back here — with `app`,
    // `flow` and `return` intact — after signing in.
    return <Navigate to="/login" state={{ returnTo: location.pathname + location.search }} replace />;
  }

  if (!appName || !flow) {
    return (
      <AuthLayout>
        <Card className="p-8">
          <AlertTriangle className="mb-3 h-6 w-6 text-amber-500" />
          <h1 className="text-lg font-semibold">Invalid sign-in link</h1>
          <p className="mt-2 text-sm opacity-80">
            Open the application again to start a new sign-in.
          </p>
        </Card>
      </AuthLayout>
    );
  }

  if (refused) {
    return (
      <AuthLayout>
        <Card className="p-8">
          <AlertTriangle className="mb-3 h-6 w-6 text-amber-500" />
          <h1 className="text-lg font-semibold">You do not have access to {appName}</h1>
          <p className="mt-2 text-sm opacity-80">
            You are signed in, but your account is not on this application&rsquo;s access list.
            Signing in again will not change that &mdash; ask the person who owns it.
          </p>
        </Card>
      </AuthLayout>
    );
  }

  if (error) {
    return (
      <AuthLayout>
        <Card className="p-8">
          <AlertTriangle className="mb-3 h-6 w-6 text-red-500" />
          <h1 className="text-lg font-semibold">Sign-in failed</h1>
          <p className="mt-2 text-sm opacity-80">{error}</p>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Card className="p-8 text-center">
        <ShieldCheck className="mx-auto mb-3 h-6 w-6" />
        <h1 className="text-lg font-semibold">Signing you in to {appName}</h1>
        <p className="mt-2 flex items-center justify-center gap-2 text-sm opacity-80">
          <Loader2 className="h-4 w-4 animate-spin" /> One moment&hellip;
        </p>
      </Card>
    </AuthLayout>
  );
}

export default AppAccessConsent;
