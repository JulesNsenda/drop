import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import { Menu, X } from 'lucide-react';

export interface AppShellProps {
  /** Sidebar nav content (nav list + footer utility items: settings, limit badge, user/logout). */
  sidebarNav: ReactNode;
  /** Header slots — PRD-045 foundation leaves these empty; PRD-047 wires them up. */
  breadcrumb?: ReactNode;
  headerSearch?: ReactNode;
  themeToggle?: ReactNode;
  headerActions?: ReactNode;
  user?: ReactNode;
  /** Main content area (typically an <Outlet />). */
  children: ReactNode;
}

function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'block',
        width: size,
        height: size,
        background: 'var(--accent)',
        borderRadius: '50% 50% 50% 3px',
        transform: 'rotate(45deg)',
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * App shell (PRD-045): 236px sidebar (logo + `sidebarNav` slot + a static
 * "daemon online" status footer) + a sticky header (slots: breadcrumb,
 * headerSearch, themeToggle, headerActions, user). Owns the responsive
 * mobile-drawer behavior (hamburger opens a slide-in drawer with an overlay
 * on narrow viewports) that previously lived in Layout.tsx.
 *
 * Carries its own `.drop-ui` token scope (see PRD §2.1 — both shells must
 * carry the scope independently, not a common ancestor above the route
 * split).
 */
function AppShell({ sidebarNav, breadcrumb, headerSearch, themeToggle, headerActions, user, children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);
  const location = useLocation();

  // Close the mobile drawer on navigation — regardless of what's rendered
  // into `sidebarNav`, so nav-item clicks (main nav + Settings) dismiss the
  // drawer the same way the pre-refactor Layout.tsx did (each NavLink had
  // its own onClick={closeSidebar}).
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className="flex items-center justify-between border-b p-4" style={{ borderColor: 'var(--border)' }}>
        <Link to="/apps" className="flex items-center gap-3" style={{ color: 'var(--text)' }}>
          <LogoMark />
          <div>
            <h1 className="text-lg font-bold leading-tight" style={{ fontFamily: 'var(--mono)', letterSpacing: 1 }}>
              DROP
            </h1>
            <p className="text-xs" style={{ color: 'var(--text-3)' }}>
              Dashboard
            </p>
          </div>
        </Link>
        <button
          onClick={closeSidebar}
          className="md:hidden"
          style={{ color: 'var(--text-3)' }}
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Nav slot (scrollable) */}
      <div className="flex-1 overflow-y-auto p-4">{sidebarNav}</div>

      {/* Daemon-status footer */}
      <div
        className="flex items-center gap-2 border-t px-4 py-3 text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--text-3)', fontFamily: 'var(--mono)' }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--ok)', boxShadow: '0 0 6px var(--ok)' }}
          aria-hidden="true"
        />
        daemon online
      </div>
    </>
  );

  return (
    <div className="drop-ui flex h-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Cmd-K palette. Lives in the shell so it is available on every
          authenticated page and nowhere else. */}
      <CommandPalette />
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          style={{ background: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — desktop */}
      <aside
        className="hidden h-screen w-[236px] flex-shrink-0 flex-col border-r md:flex"
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        {sidebarContent}
      </aside>

      {/* Sidebar — mobile drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[236px] flex-col border-r transition-transform duration-200 md:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
      >
        {sidebarContent}
      </aside>

      {/* Main column */}
      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        {/* Sticky header */}
        <header
          className="sticky top-0 z-30 flex h-14 flex-shrink-0 items-center gap-3 border-b px-4 md:px-6"
          style={{
            background: 'color-mix(in srgb, var(--bg) 88%, transparent)',
            backdropFilter: 'blur(8px)',
            borderColor: 'var(--border)',
          }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden"
            style={{ color: 'var(--text-2)' }}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 md:hidden">
            <LogoMark size={16} />
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, letterSpacing: 1, fontSize: 14 }}>DROP</span>
          </div>

          {breadcrumb}
          <div className="flex-1" />
          {headerSearch}
          {themeToggle}
          {headerActions}
          {user}
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

export default AppShell;
