import { useState, FormEvent } from 'react';
import { Box, KeyRound } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { apiJson, jsonBody } from '../api/client';
import { useNavigate } from 'react-router-dom';

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
        (json.error?.message === 'Current password is incorrect')
          ? 'The temporary password you entered is incorrect.'
          : (json.error?.message ?? 'Failed to change password. Please try again.')
      );
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-drop-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Box className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Set your password</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Choose a new password to secure your account.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6"
        >
          {error && (
            <div role="alert" className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Temporary password
            </label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
              placeholder="The password you just signed in with"
            />
          </div>

          <div className="mb-4">
            <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
              placeholder="At least 8 characters"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-drop-500 focus:border-transparent outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-drop-600 text-white rounded-lg hover:bg-drop-700 disabled:opacity-50 transition-colors font-medium"
          >
            <KeyRound className="w-4 h-4" />
            {loading ? 'Saving...' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ChangePasswordPage;
