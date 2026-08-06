import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid,
  Settings,
  Upload,
  Users,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Plus,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import LimitBadge from './LimitBadge';
import Button from './ui/Button';
import AppShell from './AppShell';

/**
 * Thin wrapper around AppShell (PRD-045/PRD-047): fills the shell's
 * `sidebarNav`, `breadcrumb`, `themeToggle`, `headerActions`, and `user`
 * slots. AppShell owns the responsive sidebar/drawer chrome; this component
 * only supplies content and behavior — see AppShell.tsx for the shell itself.
 *
 * Nav reconciliation (PRD-047 §2.1): Applications (/apps), Deploy (/deploy),
 * Users (/users, admin-only), Settings (/settings) — every item routes to a
 * real page. The mockup's top-level Databases/Domains/Logs are intentionally
 * omitted (they're per-app, surfaced on the app-detail tabs in a later slice).
 */
function Layout() {
  const { theme, setTheme } = useTheme();
  const { authRequired, username, role, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const location = useLocation();

  // PRD-026: explicit redirect + confirmation on logout. Signing out lands on
  // the login page, not the marketing site — someone who just signed out is far
  // more likely to want back in than to want the sales pitch. This stays inside
  // the dashboard bundle (BrowserRouter basename="/dashboard", see main.tsx),
  // so react-router's navigate() is correct here and the toast survives the
  // transition — a full page load would discard it before it painted.
  const handleLogout = () => {
    logout();
    toast('success', 'Signed out');
    navigate('/login', { replace: true });
  };

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const themeLabel = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 transition-colors dui-nav-link ${isActive ? 'dui-nav-link-active' : ''}`;

  const secondaryLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors dui-nav-link ${isActive ? 'dui-nav-link-active' : ''}`;

  const sidebarNav = (
    <>
      <nav>
        <ul className="space-y-1">
          <li>
            <NavLink to="/apps" end className={navLinkClass}>
              <LayoutGrid className="h-5 w-5" />
              Applications
            </NavLink>
          </li>
          <li>
            <NavLink to="/deploy" className={navLinkClass}>
              <Upload className="h-5 w-5" />
              Deploy
            </NavLink>
          </li>
          {role === 'admin' && (
            <li>
              <NavLink to="/users" className={navLinkClass}>
                <Users className="h-5 w-5" />
                Users
              </NavLink>
            </li>
          )}
        </ul>
      </nav>

      <div className="mt-6 space-y-1 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
        <NavLink to="/settings" className={secondaryLinkClass}>
          <Settings className="h-4 w-4" />
          Settings
        </NavLink>

        {authRequired && role !== 'admin' && (
          <div className="px-3 pt-1">
            <LimitBadge />
          </div>
        )}

        <div className="px-3 pt-2 text-xs" style={{ color: 'var(--text-3)' }}>
          DROP v{__DROP_VERSION__}
        </div>
      </div>
    </>
  );

  // Simple route-aware breadcrumb (PRD-047 §2.2): "Applications" on the list,
  // "Applications / {name}" on an app-detail route, otherwise the current
  // section's label. Deliberately minimal — no deep-linking beyond one level.
  let breadcrumb = null;
  const appDetailMatch = location.pathname.match(/^\/apps\/([^/]+)/);
  if (appDetailMatch) {
    breadcrumb = (
      <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-3)' }}>
        <Link to="/apps" style={{ color: 'var(--text-3)' }}>
          Applications
        </Link>
        <span aria-hidden="true">/</span>
        <span style={{ color: 'var(--text)' }}>{decodeURIComponent(appDetailMatch[1])}</span>
      </span>
    );
  } else if (location.pathname.startsWith('/apps')) {
    breadcrumb = <span style={{ color: 'var(--text)' }}>Applications</span>;
  } else if (location.pathname.startsWith('/deploy')) {
    breadcrumb = <span style={{ color: 'var(--text)' }}>Deploy</span>;
  } else if (location.pathname.startsWith('/settings')) {
    breadcrumb = <span style={{ color: 'var(--text)' }}>Settings</span>;
  } else if (location.pathname.startsWith('/users')) {
    breadcrumb = <span style={{ color: 'var(--text)' }}>Users</span>;
  }

  const themeToggle = (
    <button
      onClick={() => setTheme(nextTheme)}
      className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
      style={{ background: 'var(--bg-3)', border: '1px solid var(--border)', color: 'var(--text)' }}
      title={`Theme: ${themeLabel}`}
      aria-label={`Cycle theme (current: ${themeLabel})`}
    >
      <ThemeIcon className="h-4 w-4" />
    </button>
  );

  const headerActions = (
    <Button variant="primary" onClick={() => navigate('/deploy')} aria-label="New deploy">
      <Plus className="h-4 w-4" />
      <span className="hidden sm:inline">New deploy</span>
    </Button>
  );

  // Header account/avatar area (PRD-047 §2.2) — replaces the old sidebar
  // user block; preserves the admin badge and logout (PRD-026).
  const user = authRequired ? (
    <div
      className="ml-1 flex items-center gap-2 border-l pl-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <span
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        aria-hidden="true"
      >
        {(username || 'U').charAt(0).toUpperCase()}
      </span>
      {/* Username hides on narrow headers to save space; the avatar + admin
          badge (below) stay visible at every width — the admin badge must be
          preserved on mobile too, not just desktop. */}
      <span
        className="hidden max-w-[120px] truncate text-sm font-medium sm:inline"
        style={{ color: 'var(--text)' }}
      >
        {username || 'User'}
      </span>
      {role === 'admin' && (
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          admin
        </span>
      )}
      <button
        onClick={handleLogout}
        className="dui-nav-link flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-colors"
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  ) : null;

  return (
    <AppShell
      sidebarNav={sidebarNav}
      breadcrumb={breadcrumb}
      themeToggle={themeToggle}
      headerActions={headerActions}
      user={user}
    >
      <Outlet />
    </AppShell>
  );
}

export default Layout;
