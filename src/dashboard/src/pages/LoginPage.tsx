import { useState, FormEvent, useRef, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogIn, ShieldCheck, ArrowLeft } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Card from '../components/ui/Card';

interface LoginLocationState {
  sessionExpired?: boolean;
  message?: string;
}

/** Inline notice/error banner, token-driven (mirrors `.dui-badge-*` tone colors). */
function AuthAlert({
  tone,
  role,
  children,
}: {
  tone: 'ok' | 'err';
  role: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className="mb-4 rounded-lg border px-3 py-2.5 text-sm"
      style={{
        background: `color-mix(in srgb, var(--${tone}) 15%, transparent)`,
        borderColor: `color-mix(in srgb, var(--${tone}) 35%, transparent)`,
        color: `var(--${tone})`,
      }}
    >
      {children}
    </div>
  );
}

function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const location = useLocation();
  const state = (location.state as LoginLocationState | null) || null;
  const [notice, setNotice] = useState<string | null>(
    state?.sessionExpired ? 'Your session expired. Please sign in again.' : state?.message || null
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // MFA step — challengeToken lives only in a ref, never localStorage/state
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [totpCode, setTotpCode] = useState('');
  const challengeTokenRef = useRef<string>('');

  const handleCredentialsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice(null);
    setLoading(true);

    const result = await login(username, password);

    if (!result.success) {
      if ('mfaRequired' in result && result.mfaRequired) {
        // Store challenge token in ref only (not state, not localStorage)
        challengeTokenRef.current = result.challengeToken;
        setStep('totp');
      } else {
        setError('Invalid username or password');
      }
    }
    // If success, App.tsx route guards handle the redirect

    setLoading(false);
  };

  const handleTotpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await verifyMfa(challengeTokenRef.current, totpCode);

    if (!result.success) {
      setError('Invalid or expired code. Please try again.');
      setTotpCode('');
    }
    // On success, App.tsx route guards redirect to /apps

    setLoading(false);
  };

  const handleBackToCredentials = () => {
    setStep('credentials');
    setError('');
    setTotpCode('');
    challengeTokenRef.current = '';
  };

  return (
    <AuthLayout>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
          {step === 'totp' ? 'Two-factor authentication' : 'Sign in'}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          {step === 'totp'
            ? 'Enter the 6-digit code from your authenticator app.'
            : 'Sign in to your dashboard.'}
        </p>
      </div>

      {step === 'credentials' ? (
        <Card>
          <form onSubmit={handleCredentialsSubmit}>
            {notice && (
              <AuthAlert tone="ok" role="status">
                {notice}
              </AuthAlert>
            )}
            {error && (
              <AuthAlert tone="err" role="alert">
                {error}
              </AuthAlert>
            )}

            <div className="mb-4">
              <Input
                id="username"
                label="Username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
                placeholder="admin"
              />
            </div>

            <div className="mb-6">
              <Input
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" variant="primary" loading={loading} className="w-full">
              {!loading && <LogIn className="h-4 w-4" aria-hidden="true" />}
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>
        </Card>
      ) : (
        <Card>
          <form onSubmit={handleTotpSubmit}>
            {error && (
              <AuthAlert tone="err" role="alert">
                {error}
              </AuthAlert>
            )}

            <div className="mb-6">
              <Input
                id="totp-code"
                label="Authentication code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
                autoComplete="one-time-code"
                placeholder="000000"
                className="text-center text-2xl font-mono tracking-widest"
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              loading={loading}
              disabled={totpCode.length !== 6}
              className="w-full"
            >
              {!loading && <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
              {loading ? 'Verifying...' : 'Verify'}
            </Button>

            <Button
              type="button"
              variant="ghost"
              onClick={handleBackToCredentials}
              className="mt-3 w-full"
            >
              ← Back to sign in
            </Button>
          </form>
        </Card>
      )}

      {step === 'credentials' && (
        <div className="mt-4 space-y-2 text-center">
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Don't have an account?{' '}
            <Link to="/signup" className="font-medium" style={{ color: 'var(--accent)' }}>
              Sign up
            </Link>
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-2)' }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to home
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}

export default LoginPage;
