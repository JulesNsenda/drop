import { useState, FormEvent, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, LogIn, ShieldCheck, ArrowLeft } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface LoginLocationState {
  sessionExpired?: boolean;
  message?: string;
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

  // MFA step — challengeToken lives only in React state, never localStorage
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-drop-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            {step === 'totp' ? (
              <ShieldCheck className="w-10 h-10 text-white" />
            ) : (
              <Box className="w-10 h-10 text-white" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">DROP</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            {step === 'totp' ? 'Two-factor authentication' : 'Sign in to your dashboard'}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">v2.0.0-rc.1</p>
        </div>

        {step === 'credentials' ? (
          <form onSubmit={handleCredentialsSubmit} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-4">
            {notice && (
              <div role="status" className="mb-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400">
                {notice}
              </div>
            )}
            {error && (
              <div role="alert" className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
                {error}
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
                placeholder="admin"
              />
            </div>

            <div className="mb-6">
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 transition-colors font-medium"
            >
              <LogIn className="w-4 h-4" />
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleTotpSubmit} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-4">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Enter the 6-digit code from your authenticator app.
            </p>

            {error && (
              <div role="alert" className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
                {error}
              </div>
            )}

            <div className="mb-6">
              <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Authentication code
              </label>
              <input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
                autoComplete="one-time-code"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none text-center text-2xl tracking-widest font-mono"
                placeholder="000000"
              />
            </div>

            <button
              type="submit"
              disabled={loading || totpCode.length !== 6}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 transition-colors font-medium"
            >
              <ShieldCheck className="w-4 h-4" />
              {loading ? 'Verifying...' : 'Verify'}
            </button>

            <button
              type="button"
              onClick={handleBackToCredentials}
              className="mt-3 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-drop-600 dark:hover:text-drop-400 transition-colors"
            >
              ← Back to sign in
            </button>
          </form>
        )}

        {step === 'credentials' && (
          <div className="text-center space-y-2">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Don't have an account?{' '}
              <Link to="/signup" className="text-drop-600 hover:text-drop-500 font-medium">
                Sign up
              </Link>
            </p>
            <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-drop-600 dark:hover:text-drop-400 transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to home
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default LoginPage;
