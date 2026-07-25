import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Self-hosted fonts (JetBrains Mono + Hanken Grotesk) are imported once at the
// app entry (main.tsx) so they're available app-wide under the strict CSP —
// see PRD-045. No per-page font import needed here.

import '../styles/landing.css';
import { useTheme } from '../hooks/useTheme';
import { SiteNav } from '../components/landing/SiteNav';
import { SiteFooter } from '../components/landing/SiteFooter';
import { LandingSections } from '../components/landing/LandingSections';

function LandingPage() {
  const navigate = useNavigate();
  // Calling useTheme() here ensures the `dark` class is applied on this route,
  // which is rendered outside the dashboard Layout.
  const { theme, setTheme } = useTheme();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  // Auth-enabled probe (preserved from the previous landing) — decides the CTA
  // labels and whether to show the signup link.
  useEffect(() => {
    fetch('/api/v1/auth/status')
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setAuthEnabled(json.data.enabled);
        else setAuthEnabled(false);
      })
      .catch(() => setAuthEnabled(false));
  }, []);

  // Track the resolved theme (useTheme only exposes the raw preference) by
  // observing the `dark` class that useTheme maintains on <html>.
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDark(el.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [theme]);

  const handleEnter = () => navigate(authEnabled ? '/login' : '/apps');
  const handleSignup = () => navigate('/signup');
  const onToggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  if (authEnabled === null) {
    return (
      <div
        className="drop-landing"
        style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <span
          style={{
            display: 'block',
            width: 22,
            height: 22,
            background: 'var(--accent)',
            borderRadius: '50% 50% 50% 3px',
            transform: 'rotate(45deg)',
            boxShadow: '0 0 30px var(--accent)',
          }}
          className="animate-pulse"
        />
      </div>
    );
  }

  return (
    <div className="drop-landing">
      <SiteNav
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        onEnter={handleEnter}
        authEnabled={authEnabled}
        current="landing"
      />
      <LandingSections onEnter={handleEnter} onSignup={handleSignup} authEnabled={authEnabled} />
      <SiteFooter onEnter={handleEnter} />
    </div>
  );
}

export default LandingPage;
