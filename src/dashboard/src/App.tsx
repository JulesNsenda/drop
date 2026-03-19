import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { AuthContext, useAuthProvider } from './hooks/useAuth';
import LandingPage from './pages/LandingPage';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import SettingsPage from './pages/SettingsPage';
import DeployPage from './pages/DeployPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import UsersPage from './pages/UsersPage';

function App() {
  const auth = useAuthProvider();

  return (
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <ConfirmProvider>
        <ErrorBoundary>
          <Routes>
            {/* Public routes */}
            <Route index element={<LandingPage />} />
            <Route path="login" element={
              auth.authenticated ? <Navigate to="/apps" replace /> : <LoginPage />
            } />
            <Route path="signup" element={
              auth.authenticated ? <Navigate to="/apps" replace /> : <SignupPage />
            } />

            {/* Protected dashboard routes */}
            <Route path="/" element={
              auth.loading ? (
                <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
                  <div className="animate-pulse text-gray-400">Loading...</div>
                </div>
              ) : auth.authRequired && !auth.authenticated ? (
                <Navigate to="/login" replace />
              ) : (
                <Layout />
              )
            }>
              <Route path="apps" element={<AppsPage />} />
              <Route path="apps/:name" element={<AppDetailPage />} />
              <Route path="deploy" element={<DeployPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="users" element={<UsersPage />} />
            </Route>
          </Routes>
        </ErrorBoundary>
        </ConfirmProvider>
      </ToastProvider>
    </AuthContext.Provider>
  );
}

export default App;
