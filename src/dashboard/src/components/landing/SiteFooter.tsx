import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

export interface SiteFooterProps {
  onEnter: () => void;
}

interface FooterLinkItem {
  label: string;
  href?: string;
  to?: string;
  external?: boolean;
  enter?: boolean;
}

interface FooterColumn {
  key: string;
  title: string;
  links: FooterLinkItem[];
}

const GITHUB_URL = 'https://github.com/JulesNsenda/drop';

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    key: 'product',
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'Dashboard', enter: true },
      { label: 'Runtimes', href: '#runtimes' },
      { label: 'Changelog', href: GITHUB_URL, external: true },
    ],
  },
  {
    key: 'developers',
    title: 'Developers',
    links: [
      { label: 'Documentation', to: '/docs' },
      { label: 'API Reference', to: '/reference' },
      { label: 'CLI', to: '/reference#cli' },
      { label: 'drop.yaml', to: '/docs#drop-yaml' },
    ],
  },
  {
    key: 'resources',
    title: 'Resources',
    links: [
      { label: 'GitHub', href: GITHUB_URL, external: true },
      { label: 'Self-hosting', to: '/docs#installation' },
      { label: 'Community', href: GITHUB_URL, external: true },
      { label: 'Sign in', enter: true },
    ],
  },
];

const columnTitleStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 14,
};

const columnLinkStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-2)',
};

export function SiteFooter({ onEnter }: SiteFooterProps): JSX.Element {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-2)' }}>
      <div
        className="dl-grid-4"
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '56px 28px 40px',
          display: 'grid',
          gridTemplateColumns: '1.6fr 1fr 1fr 1fr',
          gap: 40,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span
              style={{
                display: 'block',
                width: 16,
                height: 16,
                background: 'var(--accent)',
                borderRadius: '50% 50% 50% 2px',
                transform: 'rotate(45deg)',
              }}
            />
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontWeight: 700,
                fontSize: 15,
                letterSpacing: 2,
                color: 'var(--text)',
              }}
            >
              DROP
            </span>
          </div>
          <p
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text-3)',
              lineHeight: 1.7,
              maxWidth: 280,
            }}
          >
            Deploy · Run · Operate · Publish. Hand it a folder of code, get a live app — on someone
            else&apos;s DROP, or on your own server.
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 18,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--text-3)',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#39D98A',
                boxShadow: '0 0 8px #39D98A',
              }}
            />
            All systems operational
          </div>
        </div>

        {FOOTER_COLUMNS.map((col) => (
          <div key={col.key}>
            <div style={columnTitleStyle}>{col.title}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {col.links.map((link) => {
                const linkKey = `${col.key}-${link.label}`;
                if (link.enter) {
                  return (
                    <button
                      key={linkKey}
                      type="button"
                      onClick={onEnter}
                      className="dl-hover-text"
                      style={{
                        ...columnLinkStyle,
                        fontFamily: 'inherit',
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      {link.label}
                    </button>
                  );
                }
                if (link.external) {
                  return (
                    <a
                      key={linkKey}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="dl-hover-text"
                      style={columnLinkStyle}
                    >
                      {link.label}
                    </a>
                  );
                }
                if (link.to) {
                  return (
                    <Link key={linkKey} to={link.to} className="dl-hover-text" style={columnLinkStyle}>
                      {link.label}
                    </Link>
                  );
                }
                return (
                  <a key={linkKey} href={link.href} className="dl-hover-text" style={columnLinkStyle}>
                    {link.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '20px 28px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          © 2026 DROP · MIT License
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          Built for Windows · Linux · macOS
        </span>
      </div>
    </footer>
  );
}
