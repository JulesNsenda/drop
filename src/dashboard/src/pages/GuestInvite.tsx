import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, MailCheck, ShieldCheck } from 'lucide-react';
import AuthLayout from '../components/AuthLayout';
import Card from '../components/ui/Card';

/**
 * The GUEST's page (DROP-155).
 *
 * ## Why it is not a mode inside `AppAccessConsent`
 *
 * That page's unauthenticated branch navigates to `/login` carrying a
 * `returnTo`, which is exactly right for an account holder and exactly wrong
 * for someone who has no account to sign in with. The account-holder flow
 * DEPENDS on that branch, so a guest mode inside it would have to weaken the
 * one behaviour it exists for.
 *
 * ## Why it never mounts the auth provider
 *
 * `main.tsx` renders this page STANDALONE — outside `<App>`, outside
 * `AuthContext`, outside the router. Inside them, `useAuthProvider()` probes
 * `/auth/me` on mount and the app-wide `drop:unauthorized` listener navigates
 * to `/login` when that probe fails. For a guest the probe MUST fail, so the
 * page would be torn off the screen by design before the visitor could press
 * anything.
 *
 * It also uses plain `fetch` rather than the shared API client, for the two
 * halves of the same reason: the client attaches a bearer this page must not
 * send, and it fires `drop:unauthorized` on a 401 — an event nothing is
 * listening for here, and which exists to log a user out.
 *
 * ## The two modes
 *
 * REDEEM (`?id=`, secret in the fragment) — the mail link. Requires an
 * explicit press before it spends anything: mail scanners and preview panes
 * fetch links, and a redeem on page load would burn single-use invitations
 * before the human ever clicked.
 *
 * CONTINUE (`?app=&flow=&return=`) — the visitor came back from the app via
 * `/verify` -> `/authorize`, holding the invite cookie. This is also where the
 * plan's "a present bearer always wins over an invite, leaving it unspent"
 * rule is enforced, because this is the first place in the whole chain that
 * can SEE a bearer: it lives in `localStorage`, which no redirect can carry
 * and which `/authorize` therefore cannot consult.
 */

/** Matches `API_BASE` in `api/client.ts`; not imported, to keep this page off that module entirely. */
const API_BASE = '/api/v1';

/** The key `api/client.ts` stores the dashboard session under. */
const TOKEN_KEY = 'drop-token';

type Phase = 'idle' | 'working' | 'done';

function GuestInvite() {
  /**
   * The fragment, read ONCE and scrubbed in the same breath.
   *
   * A `useState` initializer rather than an effect: an effect runs after the
   * first paint, which would leave the secret in the address bar (and in
   * anything that samples `document.URL`) for a frame. `history.replaceState`
   * also keeps it out of the back-stack and out of any `Referer` this page
   * later generates.
   *
   * Under React 18 StrictMode the initializer can run twice; the second run
   * finds an empty hash and returns '', which would lose the secret — so the
   * value is captured into a ref-like closure variable on first read.
   */
  const [secret] = useState<string>(() => readAndScrubFragment());

  const params = new URLSearchParams(window.location.search);
  const inviteId = params.get('id') ?? '';
  const appName = params.get('app') ?? '';
  const flow = params.get('flow') ?? '';
  const returnPath = params.get('return') ?? '/';

  const mode: 'continue' | 'redeem' | 'invalid' =
    appName && flow ? 'continue' : inviteId ? 'redeem' : 'invalid';

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (mode !== 'continue' || started.current) return;
    started.current = true;

    // A PRESENT BEARER WINS, and the invite is left unspent. `/authorize`
    // routed us here on the presence of an invite cookie alone — it cannot see
    // a bearer, so its choice is a hint. An account holder who happens to hold
    // a stale invite cookie belongs on the account-holder page, with the query
    // intact so nothing is lost in the hand-off.
    try {
      if (localStorage.getItem(TOKEN_KEY)) {
        window.location.replace(`/dashboard/app-access${window.location.search}`);
        return;
      }
    } catch {
      // A browser with storage blocked cannot be holding a dashboard session
      // either, so continuing as a guest is the correct fallback.
    }

    setPhase('working');
    void (async () => {
      const res = await postJson('/app-access/guest-code', {
        app: appName,
        flow,
        return: returnPath,
      });
      const redirectTo = res.body?.data?.redirectTo;
      if (!redirectTo) {
        setError(
          res.status === 403
            ? 'Your invitation to this application is no longer valid. Ask the person who invited you to send you another.'
            : 'Could not complete sign-in for this application.'
        );
        setPhase('idle');
        return;
      }
      // The app's own origin, so a full navigation rather than a router push.
      window.location.href = redirectTo;
    })();
  }, [mode, appName, flow, returnPath]);

  const redeem = async () => {
    setError('');
    setPhase('working');
    const res = await postJson('/app-access/invite-redeem', { id: inviteId, secret });
    const appUrl = res.body?.data?.appUrl;
    if (!appUrl) {
      setError(
        res.body?.error?.message ??
          'This invitation is no longer valid. Ask the person who sent it to send you another.'
      );
      setPhase('idle');
      return;
    }
    setPhase('done');
    window.location.href = appUrl;
  };

  if (mode === 'invalid') {
    return (
      <Frame icon={<AlertTriangle className="mb-3 h-6 w-6 text-amber-500" />} title="Invalid invitation link">
        <p className="mt-2 text-sm opacity-80">
          Open the invitation from your email again, or ask the person who sent it for a new one.
        </p>
      </Frame>
    );
  }

  if (mode === 'redeem' && !secret) {
    // C0 Q2's mitigation. The secret rides in the fragment, which is the half
    // an enterprise mail-link rewriter is most likely to drop — and to the
    // recipient a rewritten link is indistinguishable from a broken one. The
    // id in the PATH is what lets this say something useful instead of failing
    // blankly. Nothing is looked up to produce this message: the server would
    // become an existence oracle over invitation ids if it answered.
    return (
      <Frame icon={<AlertTriangle className="mb-3 h-6 w-6 text-amber-500" />} title="This invitation link is incomplete">
        <p className="mt-2 text-sm opacity-80">
          Part of the link is missing — some email systems shorten or rewrite links and drop it.
          Ask the person who invited you to send the invitation again, and open it directly rather
          than through a link preview.
        </p>
      </Frame>
    );
  }

  if (error) {
    return (
      <Frame icon={<AlertTriangle className="mb-3 h-6 w-6 text-red-500" />} title="Invitation not accepted">
        <p className="mt-2 text-sm opacity-80">{error}</p>
      </Frame>
    );
  }

  if (mode === 'continue') {
    return (
      <Frame icon={<ShieldCheck className="mx-auto mb-3 h-6 w-6" />} title={`Opening ${appName}`} centered>
        <p className="mt-2 flex items-center justify-center gap-2 text-sm opacity-80">
          <Loader2 className="h-4 w-4 animate-spin" /> One moment&hellip;
        </p>
      </Frame>
    );
  }

  return (
    <Frame icon={<MailCheck className="mx-auto mb-3 h-6 w-6" />} title="You have been invited" centered>
      <p className="mt-2 text-sm opacity-80">
        Someone has invited you to an application on this platform. Accepting opens it in your
        browser — you do not need an account.
      </p>
      <p className="mt-2 text-sm opacity-60">
        This invitation can only be used once. Do not share this link.
      </p>
      <button
        type="button"
        onClick={() => void redeem()}
        disabled={phase !== 'idle'}
        className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-gray-900"
      >
        {phase === 'idle' ? (
          'Accept invitation'
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Opening&hellip;
          </>
        )}
      </button>
    </Frame>
  );
}

/**
 * Reads the fragment and removes it from the URL in one step.
 *
 * Module-scoped rather than inline so StrictMode's second render of the
 * `useState` initializer returns the SAME value instead of an empty string —
 * by then the address bar has already been scrubbed, and re-reading it would
 * silently discard the secret and show the visitor a broken-link page for an
 * invitation that was perfectly good.
 */
let capturedSecret: string | null = null;
function readAndScrubFragment(): string {
  if (capturedSecret !== null) return capturedSecret;
  // `decodeURIComponent` THROWS on a stray or truncated `%`, which is exactly
  // the shape C0 Q2 says a mail-link rewriter may leave behind — and an
  // uncaught throw in a `useState` initializer blanks the page during render.
  // That would defeat the incomplete-link message below in the one scenario
  // the id-in-the-path mitigation exists for.
  let raw = '';
  try {
    raw = window.location.hash.startsWith('#')
      ? decodeURIComponent(window.location.hash.slice(1))
      : '';
  } catch {
    raw = '';
  }
  capturedSecret = raw;
  if (raw) {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      // Scrubbing is hygiene, not a control — the secret is single-use and
      // already spent moments later. Never let it stop the flow.
    }
  }
  return raw;
}

interface Envelope {
  data?: { redirectTo?: string; appUrl?: string; appName?: string };
  error?: { message?: string };
}

/** Plain fetch — see this module's doc for why the shared client is avoided. */
async function postJson(
  path: string,
  body: unknown
): Promise<{ status: number; body: Envelope | null }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Same-origin by default, which is what sends the `__Host-drop-invite`
      // cookie — stated because a future refactor to `credentials: 'omit'`
      // would break the continue hop silently.
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Envelope | null };
  } catch {
    return { status: 0, body: null };
  }
}

function Frame({
  icon,
  title,
  centered,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  centered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AuthLayout>
      <Card className={centered ? 'p-8 text-center' : 'p-8'}>
        {icon}
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </Card>
    </AuthLayout>
  );
}

export default GuestInvite;
