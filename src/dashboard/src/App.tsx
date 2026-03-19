import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { AuthContext, useAuthProvider } from './hooks/useAuth';
import AppsPage from './pages/AppsPage';
import AppDetailPage from './pages/AppDetailPage';
import SettingsPage from './pages/SettingsPage';
import DeployPage from './pages/DeployPage';
import GitDeployPage from './pages/GitDeployPage';
import LoginPage from './pages/LoginPage';

function App() {
  const auth = useAuthProvider();

  // Show login page if auth is required and not authenticated
  if (auth.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={auth}>
      <ToastProvider>
        <ErrorBoundary>
          {auth.authRequired && !auth.authenticated ? (
            <LoginPage />
          ) : (
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<AppsPage />} />
                <Route path="apps/:name" element={<AppDetailPage />} />
                <Route path="deploy" element={<DeployPage />} />
                <Route path="deploy/git" element={<GitDeployPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          )}
        </ErrorBoundary>
      </ToastProvider>
    </AuthContext.Provider>
  );
}

export default App;
