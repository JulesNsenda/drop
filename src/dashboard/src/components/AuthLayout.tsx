import { ReactNode } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

export interface AuthLayoutProps {
  /** The auth form (login / signup / change-password). */
  children: ReactNode;
  /** Host-status footer line on the branding panel, e.g. "drop-node-01 · v2.0.0-rc.3 · self-hosted". */
  hostStatus?: string;
}

const DEFAULT_HOST_STATUS = `drop-node-01 · v${__DROP_VERSION__} · self-hosted`;

/**
 * Split-screen auth shell (PRD-045), from `Login.dc.html`: a left branding
 * panel (animated diamond, "Drop a folder. / Get a URL." headline, a short
 * description, a host-status footer line) and a right panel — a centered
 * form container with a theme toggle in the corner — that renders `children`
 * (the actual login/signup/change-password form).
 *
 * Renders on public routes outside `Layout` (see PRD §2.1), so it carries
 * the `.drop-ui` token scope on its own root and drives `useTheme()` itself
 * (same pattern LandingPage uses) so the `dark` class is applied here too.
 * Collapses to a single column (form only) on narrow viewports.
 */
function AuthLayout({ children, hostStatus = DEFAULT_HOST_STATUS }: AuthLayoutProps) {
  const { theme, setTheme } = useTheme();
  const isDark =
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : theme === 'dark';
  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <div className="drop-ui flex min-h-screen bg-surface text-fg">
      {/* Left — branding panel (hidden on narrow viewports) */}
      <div
        className="relative hidden flex-1 flex-col justify-between overflow-hidden p-10 md:flex"
        style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--border)' }}
      >
        <div />

        <div className="flex flex-col items-start gap-6">
          <span className="dui-auth-logo" aria-hidden="true" />
          <h1
            className="text-4xl font-bold leading-tight font-mono text-fg"
          >
            Drop a folder.
            <br />
            Get a URL.
          </h1>
          <p className="max-w-sm text-sm text-muted">
            DROP watches a folder, detects your app, builds it, and routes traffic to it — zero configuration for
            most projects.
          </p>
        </div>

        <div
          className="text-xs text-faint font-mono"
        >
          {hostStatus}
        </div>
      </div>

      {/* Right — form panel */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-10">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg transition-colors md:right-6 md:top-6"
          style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--text)' }}
        >
          {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>

        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

export default AuthLayout;
