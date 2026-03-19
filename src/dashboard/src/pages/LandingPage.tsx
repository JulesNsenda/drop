import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

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

  useEffect(() => {
    if (!loading && authenticated) {
      navigate('/apps', { replace: true });
    }
  }, [loading, authenticated, navigate]);

  if (loading || authEnabled === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-10 h-10 bg-drop-500 rounded-xl flex items-center justify-center animate-pulse">
          <Box className="w-6 h-6 text-white" />
        </div>
      </div>
    );
  }

  const handleEnter = () => {
    navigate(authEnabled ? '/login' : '/apps');
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center relative overflow-hidden">
      {/* Subtle gradient backdrop */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.08),transparent_70%)]" />

      {/* Content */}
      <div className="relative z-10 text-center px-6">
        {/* Logo */}
        <div
          className="w-14 h-14 bg-drop-500 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg shadow-drop-500/20 cursor-pointer hover:scale-105 transition-transform"
          onClick={handleEnter}
        >
          <Box className="w-8 h-8 text-white" />
        </div>

        {/* Title */}
        <h1 className="text-5xl font-bold text-white mb-3 tracking-tight">
          DROP
        </h1>

        {/* One line */}
        <p className="text-gray-400 text-lg mb-12 max-w-md mx-auto">
          Drop a folder. Get a URL.
        </p>

        {/* CTA */}
        <button
          onClick={handleEnter}
          className="group px-8 py-3 bg-white/5 border border-white/10 text-white rounded-full hover:bg-white/10 hover:border-white/20 transition-all text-sm font-medium tracking-wide"
        >
          {authEnabled ? 'Sign in' : 'Open Dashboard'}
          <span className="inline-block ml-2 group-hover:translate-x-1 transition-transform">&rarr;</span>
        </button>
      </div>

      {/* Minimal footer */}
      <div className="absolute bottom-6 text-gray-600 text-xs tracking-wider uppercase">
        Self-hosted PaaS
      </div>
    </div>
  );
}

export default LandingPage;
