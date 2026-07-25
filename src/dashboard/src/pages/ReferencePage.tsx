import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Self-hosted fonts (bundled as same-origin assets — required by the app CSP,
// which blocks external Google Fonts). Same setup as LandingPage.tsx / DocsPage.tsx.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';

import '../styles/landing.css';
import { useTheme } from '../hooks/useTheme';
import { SiteNav } from '../components/landing/SiteNav';
import { SiteFooter } from '../components/landing/SiteFooter';
import { REF_ITEM_IDS, RefRail, RefToc, ReferenceBody } from '../components/landing/ReferenceContent';

/**
 * Scroll-spy: tracks which reference section is currently in view so the left
 * TOC and right "on this page" rail can highlight it. CSP-safe —
 * IntersectionObserver only, no external libs. Identical to DocsPage's hook
 * (PRD-043); duplicated rather than shared since it's a five-line hook keyed
 * to the id list passed in.
 */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState<string>(ids[0] ?? '');

  useEffect(() => {
    const elements = ids
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
        }
      },
      // Treat a section as "active" once it clears the sticky nav, and stop
      // tracking it once it's within the last ~60% of the viewport — keeps
      // the highlighted item close to what's actually being read.
      { rootMargin: '-96px 0px -60% 0px', threshold: [0, 1] }
    );

    elements.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [ids]);

  return active;
}

function ReferencePage(): JSX.Element {
  const navigate = useNavigate();
  // Calling useTheme() here ensures the `dark` class is applied on this route,
  // which is rendered outside the dashboard Layout.
  const { theme, setTheme } = useTheme();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );
  const activeId = useActiveSection(REF_ITEM_IDS);

  // Auth-enabled probe — decides whether nav/footer CTAs read "Sign in" or
  // "Enter". Page content itself doesn't depend on it, so we don't block
  // rendering while it's in flight (mirrors DocsPage).
  useEffect(() => {
    fetch('/api/v1/auth/status')
      .then(r => r.json())
      .then(json => {
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
  const onToggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  const scrollToSection = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
  }, []);

  // Deep-link support: land directly on a section for links like
  // /reference#cli (used by SiteFooter's "CLI" link). Jump instantly (no
  // smooth animation) on first paint.
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, '');
    if (!id || !REF_ITEM_IDS.includes(id)) return;
    const raf = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="drop-landing">
      <SiteNav
        isDark={isDark}
        onToggleTheme={onToggleTheme}
        onEnter={handleEnter}
        authEnabled={authEnabled ?? false}
        current="api"
      />

      <header style={{ maxWidth: 1200, margin: '0 auto', padding: '48px 28px 8px' }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 12,
          }}
        >
          API &amp; CLI Reference
        </div>
        <h1
          style={{
            fontFamily: 'var(--mono)',
            fontWeight: 700,
            fontSize: 38,
            letterSpacing: -1,
            marginBottom: 12,
            color: 'var(--text)',
          }}
        >
          Every endpoint and command, from source.
        </h1>
        <p style={{ fontSize: 16, color: 'var(--text-2)', maxWidth: 620, lineHeight: 1.7 }}>
          The REST API (mounted at <code>/api/v1</code>) and the <code>drop</code> CLI, enumerated directly from{' '}
          <code>src/api/routes/</code> and <code>src/cli/commands/</code> — not an illustrative sketch.
        </p>
      </header>

      <div className="dl-docs-grid">
        <aside className="dl-docs-toc">
          <RefToc activeId={activeId} onNavigate={scrollToSection} />
        </aside>
        <div className="dl-docs-content">
          <ReferenceBody />
        </div>
        <aside className="dl-docs-rail">
          <RefRail activeId={activeId} onNavigate={scrollToSection} />
        </aside>
      </div>

      <SiteFooter onEnter={handleEnter} />
    </div>
  );
}

export default ReferencePage;
