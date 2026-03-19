import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

function LandingPage() {
  const { authenticated, loading } = useAuth();
  const navigate = useNavigate();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState(false);

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

  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 100);
    return () => clearTimeout(t);
  }, []);

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
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center relative overflow-hidden select-none">
      {/* Ambient glow */}
      <div className="absolute inset-0">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-drop-500/[0.04] rounded-full blur-3xl" />
      </div>

      {/* Content */}
      <div className={`relative z-10 text-center px-6 transition-all duration-1000 ease-out ${revealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        {/* Logo */}
        <div
          className="w-12 h-12 bg-drop-500 rounded-xl flex items-center justify-center mx-auto mb-10 cursor-pointer hover:rotate-12 transition-transform duration-300"
          onClick={handleEnter}
        >
          <Box className="w-7 h-7 text-white" />
        </div>

        {/* The hook */}
        <p className="text-gray-500 text-sm uppercase tracking-[0.3em] mb-6">
          What if deploying was just
        </p>

        <h1 className="text-6xl md:text-7xl font-bold text-white mb-4 tracking-tight leading-none">
          dropping<br />a folder<span className="text-drop-500">?</span>
        </h1>

        <div className={`transition-all duration-1000 delay-700 ${revealed ? 'opacity-100' : 'opacity-0'}`}>
          <p className="text-gray-600 text-sm mb-14">
            No config. No pipelines. No YAML.
          </p>

          {/* CTA */}
          <button
            onClick={handleEnter}
            className="group px-8 py-3 bg-drop-500 text-white rounded-full hover:bg-drop-400 transition-all text-sm font-medium shadow-lg shadow-drop-500/20 hover:shadow-drop-500/30"
          >
            {authEnabled ? 'Enter' : 'Enter'}
            <span className="inline-block ml-2 group-hover:translate-x-1 transition-transform">&rarr;</span>
          </button>
        </div>
      </div>

      {/* Bottom text */}
      <div className={`absolute bottom-8 text-gray-700 text-[11px] tracking-widest uppercase transition-opacity duration-1000 delay-1000 ${revealed ? 'opacity-100' : 'opacity-0'}`}>
        DROP &middot; Self-hosted PaaS
      </div>
    </div>
  );
}

export default LandingPage;
