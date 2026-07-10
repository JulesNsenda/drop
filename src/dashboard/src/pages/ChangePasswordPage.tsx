import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiJson, jsonBody } from '../api/client';
import AuthLayout from '../components/AuthLayout';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Card from '../components/ui/Card';

function ChangePasswordPage() {
  const { clearMustChangePassword } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const json = await apiJson('/auth/password', {
      method: 'PUT',
      ...jsonBody({ currentPassword, newPassword }),
    });
    setLoading(false);

    if (json.success) {
      clearMustChangePassword();
      navigate('/apps', { replace: true });
    } else {
      setError(
        json.error?.message === 'Current password is incorrect'
          ? 'The temporary password you entered is incorrect.'
          : (json.error?.message ?? 'Failed to change password. Please try again.')
      );
    }
  };

  return (
    <AuthLayout>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--text)' }}>
          Set your password
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-2)' }}>
          Choose a new password to secure your account.
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
              id="currentPassword"
              label="Temporary password"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              required
              autoFocus
              placeholder="The password you just signed in with"
            />
          </div>

          <div className="mb-4">
            <Input
              id="newPassword"
              label="New password"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              placeholder="At least 8 characters"
            />
          </div>

          <div className="mb-6">
            <Input
              id="confirmPassword"
              label="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {!loading && <KeyRound className="h-4 w-4" aria-hidden="true" />}
            {loading ? 'Saving...' : 'Set password'}
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}

export default ChangePasswordPage;
