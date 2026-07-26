import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';
import { useTheme } from '../hooks/useTheme';
import { SiteNav } from '../components/landing/SiteNav';
import { SiteFooter } from '../components/landing/SiteFooter';

// The marketing bundle makes no API calls (DROP-070) — see LandingPage.tsx's
// AUTH_ENABLED constant for why this is fixed rather than probed.
const AUTH_ENABLED = true;

/**
 * 404 for the marketing site bundle (DROP-070). `server.ts` registers
 * explicit routes only (`/`, `/docs`, `/reference`), so an unknown path
 * never reaches this bundle over the network — this only fires on stray
 * client-side navigation within the site's own router. Rendering a real
 * not-found page here, rather than SiteApp's previous silent bounce to the
 * landing page, keeps a future server/client route divergence visible
 * instead of masking it as "the homepage loaded, nothing's wrong".
 */
function SiteNotFoundPage() {
  const { theme, setTheme } = useTheme();
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDark(el.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [theme]);

  // The dashboard/login page lives in a separate bundle (DROP-070) — this has
  // to be a full page navigation, not react-router's navigate().
  const handleEnter = () => {
    window.location.href = '/dashboard/login';
  };
  const onToggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <div className="drop-landing" style={{ display: 'flex', flexDirection: 'column' }}>
      <SiteNav isDark={isDark} onToggleTheme={onToggleTheme} onEnter={handleEnter} authEnabled={AUTH_ENABLED} />
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '64px 28px',
        }}
      >
        <p style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 60, color: 'var(--text-3)' }}>404</p>
        <h1 style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 24, marginTop: 12, color: 'var(--text)' }}>
          Page not found
        </h1>
        <p style={{ marginTop: 8, color: 'var(--text-2)' }}>The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        {/* Internal to this bundle's own router — a real SPA Link, not a full navigation. */}
        <Link to="/" style={{ marginTop: 24, fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--accent)' }}>
          Back to the homepage
        </Link>
      </div>
      <SiteFooter onEnter={handleEnter} />
    </div>
  );
}

export default SiteNotFoundPage;
