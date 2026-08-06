import { useEffect, useState } from 'react';

// Self-hosted fonts (JetBrains Mono + Hanken Grotesk) are imported once at the
// site entry (site-main.tsx) so they're available across the marketing site
// under the strict CSP — see PRD-045. No per-page font import needed here.

import '../styles/landing.css';
import { useTheme } from '../hooks/useTheme';
import { SiteNav } from '../components/landing/SiteNav';
import { SiteFooter } from '../components/landing/SiteFooter';
import { LandingSections } from '../components/landing/LandingSections';

// The marketing bundle makes no API calls (DROP-070) — there is no
// `/api/v1/auth/status` probe here anymore. Auth is on by default (see
// .claude/CLAUDE.md), so this is a fixed assumption rather than a runtime
// value; it only affects SiteNav's CTA copy ("Sign in" vs "Enter"). Every CTA
// crosses into the dashboard bundle via a full page navigation regardless.
const AUTH_ENABLED = true;

function LandingPage() {
  // Calling useTheme() here ensures the `dark` class is applied on this route.
  const { theme, setTheme } = useTheme();
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

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

  // The dashboard/login/signup pages live in a separate bundle (DROP-070) —
  // this has to be a full page navigation, not react-router's navigate().
  const handleEnter = () => {
    window.location.href = '/dashboard/login';
  };
  // No handleSignup: self-service signup is off (DROP_ALLOW_SIGNUP defaults to
  // false), so the landing's CTAs point at the invite request instead — see
  // REQUEST_ACCESS_URL in LandingSections.
  const onToggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <div className="drop-landing">
      <SiteNav
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        onEnter={handleEnter}
        authEnabled={AUTH_ENABLED}
        current="landing"
      />
      <LandingSections onEnter={handleEnter} />
      <SiteFooter onEnter={handleEnter} />
    </div>
  );
}

export default LandingPage;
