import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutGrid, Settings, Upload, Users, Sun, Moon, Monitor, LogOut, User } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import LimitBadge from './LimitBadge';
import AppShell from './AppShell';

/**
 * Thin wrapper around AppShell (PRD-045): fills the shell's `sidebarNav` and
 * `themeToggle` slots with the real nav items, LimitBadge, theme toggle, and
 * logout. AppShell owns the responsive sidebar/drawer chrome; this component
 * only supplies content and behavior — see AppShell.tsx for the shell itself.
 */
function Layout() {
  const { theme, setTheme } = useTheme();
  const { authRequired, username, role, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  // PRD-026: explicit redirect to the landing page + confirmation on logout.
  const handleLogout = () => {
    logout();
    toast('success', 'Signed out');
    navigate('/', { replace: true });
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

        {authRequired && (
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-2)' }}>
              <User className="h-4 w-4" />
              <span className="max-w-[100px] truncate">{username || 'User'}</span>
              {role === 'admin' && (
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                >
                  admin
                </span>
              )}
            </div>
            <button
              onClick={handleLogout}
              className="transition-colors"
              style={{ color: 'var(--text-3)' }}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}

        {authRequired && role !== 'admin' && (
          <div className="px-3 mb-1">
            <LimitBadge />
          </div>
        )}

        <div className="px-3 text-xs" style={{ color: 'var(--text-3)' }}>
          DROP v2.0.0-rc.1
        </div>
      </div>
    </>
  );

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

  return (
    <AppShell sidebarNav={sidebarNav} themeToggle={themeToggle}>
      <Outlet />
    </AppShell>
  );
}

export default Layout;
