import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';

export interface SiteNavProps {
  isDark: boolean;
  onToggleTheme: () => void;
  onEnter: () => void;
  authEnabled: boolean;
  current?: 'landing' | 'docs' | 'api' | 'dashboard';
}

type NavKey = 'features' | 'docs' | 'api' | 'dashboard';

interface NavLinkItem {
  key: NavKey;
  label: string;
  href?: string;
  external?: boolean;
  enter?: boolean;
}

const GITHUB_URL = 'https://github.com/JulesNsenda/drop';

const NAV_LINKS: NavLinkItem[] = [
  { key: 'features', label: 'Features', href: '#features' },
  { key: 'docs', label: 'Docs', href: GITHUB_URL, external: true },
  { key: 'api', label: 'API', href: GITHUB_URL, external: true },
  { key: 'dashboard', label: 'Dashboard', enter: true },
];

export function SiteNav({ isDark, onToggleTheme, onEnter, authEnabled, current }: SiteNavProps): JSX.Element {
  const navLinkStyle = (key: NavKey): CSSProperties => ({
    fontFamily: 'var(--mono)',
    fontSize: 13,
    padding: '7px 12px',
    borderRadius: 7,
    color: key === current ? 'var(--text)' : 'var(--text-2)',
  });

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        height: 60,
        padding: '0 28px',
        background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}>
        <span
          style={{
            display: 'block',
            width: 18,
            height: 18,
            background: 'var(--accent)',
            borderRadius: '50% 50% 50% 2px',
            transform: 'rotate(45deg)',
          }}
        />
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16, letterSpacing: 2 }}>DROP</span>
        <span
          className="dl-hide-xs"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--text-3)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            padding: '2px 6px',
            letterSpacing: 0.5,
          }}
        >
          v2.0.0-rc.1
        </span>
      </Link>

      <div style={{ flex: 1 }} />

      <div className="dl-hide-sm" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {NAV_LINKS.map((link) => {
          if (link.enter) {
            return (
              <button
                key={link.key}
                type="button"
                onClick={onEnter}
                style={{ ...navLinkStyle(link.key), background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {link.label}
              </button>
            );
          }
          if (link.external) {
            return (
              <a
                key={link.key}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                style={navLinkStyle(link.key)}
              >
                {link.label}
              </a>
            );
          }
          return (
            <a key={link.key} href={link.href} style={navLinkStyle(link.key)}>
              {link.label}
            </a>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          aria-label="Toggle theme"
          onClick={onToggleTheme}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            background: 'var(--bg-3)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            cursor: 'pointer',
            color: 'var(--text)',
          }}
        >
          {isDark ? <Moon size={15} /> : <Sun size={15} />}
        </button>

        <button
          type="button"
          onClick={onEnter}
          className="dl-hide-xs"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            padding: '8px 14px',
            borderRadius: 8,
            color: 'var(--text-2)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {authEnabled ? 'Sign in' : 'Enter'}
        </button>

        <button
          type="button"
          onClick={onEnter}
          className="dl-hover-accent2"
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            fontWeight: 600,
            padding: '8px 16px',
            borderRadius: 8,
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Get started
        </button>
      </div>
    </nav>
  );
}
