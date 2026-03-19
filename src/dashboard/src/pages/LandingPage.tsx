import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, GitBranch, Database, Shield, Zap, ArrowRight } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

const features = [
  {
    icon: Zap,
    title: 'Drop & Deploy',
    description: 'Drop a folder or paste a GitHub URL. Your app is live in seconds.',
    color: 'text-yellow-500',
    bg: 'bg-yellow-500/10',
  },
  {
    icon: GitBranch,
    title: 'GitHub Integration',
    description: 'Deploy from any GitHub repo. Auto-redeploy on push via webhooks.',
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
  },
  {
    icon: Database,
    title: 'Auto Database',
    description: 'PostgreSQL provisioned automatically. DATABASE_URL injected for you.',
    color: 'text-green-500',
    bg: 'bg-green-500/10',
  },
  {
    icon: Shield,
    title: 'Secure by Default',
    description: 'HTTPS via Caddy, encrypted secrets, JWT auth, and rate limiting.',
    color: 'text-purple-500',
    bg: 'bg-purple-500/10',
  },
];

function LandingPage() {
  const { authenticated, loading } = useAuth();
  const navigate = useNavigate();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/v1/auth/status')
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setAuthEnabled(json.data.enabled);
      })
      .catch(() => setAuthEnabled(false));
  }, []);

  // If already authenticated, go straight to dashboard
  useEffect(() => {
    if (!loading && authenticated) {
      navigate('/apps', { replace: true });
    }
  }, [loading, authenticated, navigate]);

  if (loading || authEnabled === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="animate-pulse text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-drop-500 rounded-lg flex items-center justify-center">
              <Box className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-gray-900 dark:text-white">DROP</span>
          </div>
          {authEnabled ? (
            <button
              onClick={() => navigate('/login')}
              className="text-sm font-medium text-drop-600 hover:text-drop-700 dark:text-drop-400 dark:hover:text-drop-300 transition-colors"
            >
              Sign in
            </button>
          ) : (
            <button
              onClick={() => navigate('/apps')}
              className="text-sm font-medium text-drop-600 hover:text-drop-700 dark:text-drop-400 dark:hover:text-drop-300 transition-colors"
            >
              Open Dashboard
            </button>
          )}
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="w-16 h-16 bg-drop-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Box className="w-10 h-10 text-white" />
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4 tracking-tight">
          Deploy, Run, Operate, Publish
        </h1>
        <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto mb-8 leading-relaxed">
          A self-hosted platform that turns folders and GitHub repos into running applications.
          Zero configuration. Automatic detection. Batteries included.
        </p>
        <div className="flex gap-3 justify-center">
          {authEnabled ? (
            <button
              onClick={() => navigate('/login')}
              className="inline-flex items-center gap-2 px-6 py-3 bg-drop-600 text-white rounded-lg hover:bg-drop-700 font-medium transition-colors"
            >
              Sign in to Dashboard
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => navigate('/apps')}
              className="inline-flex items-center gap-2 px-6 py-3 bg-drop-600 text-white rounded-lg hover:bg-drop-700 font-medium transition-colors"
            >
              Open Dashboard
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="grid gap-6 md:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.title}
              className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6"
            >
              <div className={`w-10 h-10 ${f.bg} rounded-lg flex items-center justify-center mb-4`}>
                <f.icon className={`w-5 h-5 ${f.color}`} />
              </div>
              <h3 className="font-semibold text-gray-900 dark:text-white mb-1">{f.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800">
        <div className="max-w-5xl mx-auto px-6 py-6 text-center text-xs text-gray-400 dark:text-gray-600">
          DROP &mdash; Self-hosted PaaS
        </div>
      </footer>
    </div>
  );
}

export default LandingPage;
