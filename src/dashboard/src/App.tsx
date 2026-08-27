import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { AuthContext, useAuthProvider } from './hooks/useAuth';
import { UNAUTHORIZED_EVENT, MUST_CHANGE_PASSWORD_EVENT } from './api/client';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import CatalogPage from './pages/CatalogPage';
import SettingsPage from './pages/SettingsPage';
import DeployPage from './pages/DeployPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import UsersPage from './pages/UsersPage';
import NotFoundPage from './pages/NotFoundPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import OAuthConsent from './pages/OAuthConsent';
import AppAccessConsent from './pages/AppAccessConsent';
import GuestInvite from './pages/GuestInvite';

function App() {
  const auth = useAuthProvider();
  const navigate = useNavigate();

  // When any API call detects an expired/invalid session, send the user to
  // login with a notice (PRD-024).
  useEffect(() => {
    const onUnauthorized = () => {
      auth.logout();
      navigate('/login', { replace: true, state: { sessionExpired: true } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [auth, navigate]);

  // When any API call returns 403 MUST_CHANGE_PASSWORD, redirect to the
  // change-password page (catches stray in-flight calls before the route
  // guard fires).
  useEffect(() => {
    const onMustChange = () => navigate('/change-password', { replace: true });
    window.addEventListener(MUST_CHANGE_PASSWORD_EVENT, onMustChange);
    return () => window.removeEventListener(MUST_CHANGE_PASSWORD_EVENT, onMustChange);
  }, [navigate]);

  return (
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <ConfirmProvider>
        <ErrorBoundary>
          <Routes>
            {/* Public routes */}
            {/* The marketing landing page moved to its own bundle at "/"
                (DROP-070) — the dashboard's index route no longer renders it;
                a logged-out visitor here goes straight to login instead. */}
            <Route index element={
              auth.loading ? (
                <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
                  <div className="animate-pulse text-gray-400">Loading...</div>
                </div>
              ) : auth.authenticated ? (
                auth.mustChangePassword ? <Navigate to="/change-password" replace /> : <Navigate to="/apps" replace />
              ) : (
                <Navigate to="/login" replace />
              )
            } />
            <Route path="login" element={
              auth.authenticated
                ? (auth.mustChangePassword ? <Navigate to="/change-password" replace /> : <Navigate to="/apps" replace />)
                : <LoginPage />
            } />
            <Route path="signup" element={
              auth.authenticated ? <Navigate to="/apps" replace /> : <SignupPage />
            } />

            {/* OAuth 2.1 consent (PRD-041) — standalone AuthLayout route, no
                sidebar, self-manages auth (redirects to /login with a
                returnTo when signed out; see refinement #1 in the OAuth
                execution plan). */}
            <Route path="oauth-consent" element={<OAuthConsent />} />
            {/* The browser access gate's SPA hop (DROP-152): the only place that
                can read the localStorage session a top-level 302 cannot carry. */}
            <Route path="app-access" element={<AppAccessConsent />} />
            {/* The GUEST's hop (DROP-155). A public route beside its two
                siblings, not a second React root: it was mounted outside
                <App> on the belief that a failed /auth/me probe would bounce
                a guest to /login, and that is false — `client.ts` only fires
                `drop:unauthorized` when a token is PRESENT, which a guest
                never has. The page handles its own unauthenticated state, as
                AppAccessConsent and OAuthConsent already do. */}
            <Route path="app-invite" element={<GuestInvite />} />

            {/* Docs (PRD-043) and API/CLI reference (PRD-044) moved to the
                marketing site bundle at /docs and /reference (DROP-070) —
                server.ts 301-redirects the old /dashboard/docs and
                /dashboard/reference paths there instead of routing here. */}

            {/* Force-password-change — accessible while authenticated */}
            <Route path="change-password" element={
              auth.authenticated ? <ChangePasswordPage /> : <Navigate to="/login" replace />
            } />

            {/* Protected dashboard routes */}
            <Route path="/" element={
              auth.loading ? (
                <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
                  <div className="animate-pulse text-gray-400">Loading...</div>
                </div>
              ) : auth.authRequired && !auth.authenticated ? (
                <Navigate to="/login" replace />
              ) : auth.mustChangePassword ? (
                <Navigate to="/change-password" replace />
              ) : (
                <Layout />
              )
            }>
              <Route path="apps" element={<AppsPage />} />
              <Route path="apps/:name" element={<AppDetailPage />} />
              <Route path="catalog" element={<CatalogPage />} />
              <Route path="deploy" element={<DeployPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="users" element={<UsersPage />} />
            </Route>

            {/* 404 (PRD-025) */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </AuthContext.Provider>
  );
}

export default App;
