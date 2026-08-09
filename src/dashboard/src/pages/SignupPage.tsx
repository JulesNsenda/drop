import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UserPlus, ArrowLeft } from 'lucide-react';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Card from '../components/ui/Card';
import { deriveSiteOrigin } from '../lib/site-url';

/** Module scope: the host cannot change without a full page load. */
const siteOrigin = deriveSiteOrigin(window.location.protocol, window.location.hostname);

function SignupPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });

      const json = await res.json();
      if (json.success) {
        navigate('/login', { state: { message: 'Account created. Sign in to continue.' } });
      } else {
        setError(json.error?.message || 'Registration failed');
      }
    } catch {
      setError('Failed to connect to server');
    }
    setLoading(false);
  };

  return (
    <AuthLayout>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
          Create account
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          Start deploying in seconds.
        </p>
      </div>

      <Card>
        <form onSubmit={handleSubmit}>
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

          <div className="mb-4">
            <Input
              id="username"
              label="Username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              minLength={3}
              pattern="^[a-zA-Z0-9_-]+$"
              autoFocus
              placeholder="Choose a username"
            />
          </div>

          <div className="mb-4">
            <Input
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </div>

          <div className="mb-4">
            <Input
              id="password"
              label="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="At least 8 characters"
            />
          </div>

          <div className="mb-6">
            <Input
              id="confirm"
              label="Confirm password"
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
            />
          </div>

          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {!loading && <UserPlus className="h-4 w-4" aria-hidden="true" />}
            {loading ? 'Creating account...' : 'Create account'}
          </Button>
        </form>
      </Card>

      <div className="mt-4 space-y-2 text-center">
        <p className="text-sm" style={{ color: 'var(--text-2)' }}>
          Already have an account?{' '}
          <Link to="/login" className="font-medium" style={{ color: 'var(--accent)' }}>
            Sign in
          </Link>
        </p>
        {/* Absolute cross-origin link — see the note in LoginPage.tsx and the
            rationale in lib/site-url.ts. `null` means this install has no
            separate marketing site, so render nothing rather than a loop. */}
        {siteOrigin && (
          <a
            href={siteOrigin}
            className="inline-flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: 'var(--text-2)' }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to home
          </a>
        )}
      </div>
    </AuthLayout>
  );
}

export default SignupPage;
