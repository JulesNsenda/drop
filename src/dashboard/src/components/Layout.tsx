import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { LayoutGrid, Settings, Box, Upload, Users, Sun, Moon, Monitor, LogOut, User, Menu, X } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';

function Layout() {
  const { theme, setTheme } = useTheme();
  const { authRequired, username, role, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const themeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const ThemeIcon = themeIcon;
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const themeLabel = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
      isActive ? 'bg-drop-600 text-white' : 'text-gray-300 hover:bg-gray-800'
    }`;

  const closeSidebar = () => setSidebarOpen(false);

  const sidebar = (
    <>
      {/* Logo */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-drop-500 rounded-lg flex items-center justify-center">
              <Box className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-lg">DROP</h1>
              <p className="text-xs text-gray-400">Dashboard</p>
            </div>
          </div>
          <button onClick={closeSidebar} className="md:hidden text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          <li><NavLink to="/apps" end className={navLinkClass} onClick={closeSidebar}><LayoutGrid className="w-5 h-5" />Applications</NavLink></li>
          <li><NavLink to="/deploy" className={navLinkClass} onClick={closeSidebar}><Upload className="w-5 h-5" />Deploy</NavLink></li>
          {role === 'admin' && (
            <li><NavLink to="/users" className={navLinkClass} onClick={closeSidebar}><Users className="w-5 h-5" />Users</NavLink></li>
          )}
        </ul>
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-gray-800 space-y-1">
        <NavLink to="/settings" onClick={closeSidebar} className={({ isActive }) => `flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors ${isActive ? 'bg-drop-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
          <Settings className="w-4 h-4" />Settings
        </NavLink>
        <button onClick={() => setTheme(nextTheme)} className="flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors">
          <ThemeIcon className="w-4 h-4" /><span>{themeLabel}</span>
        </button>
        {authRequired && (
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <User className="w-4 h-4" />
              <span className="truncate max-w-[100px]">{username || 'User'}</span>
              {role === 'admin' && (
                <span className="text-[10px] px-1.5 py-0.5 bg-drop-500/20 text-drop-400 rounded font-medium uppercase">admin</span>
              )}
            </div>
            <button onClick={logout} className="text-gray-500 hover:text-white transition-colors" title="Sign out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="text-xs text-gray-600 px-3">DROP v1.0</div>
      </div>
    </>
  );

  return (
    <div className="h-screen flex bg-gray-50 dark:bg-gray-900 overflow-hidden">
      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-drop-500 rounded-lg flex items-center justify-center">
            <Box className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-white">DROP</span>
        </div>
        <button onClick={() => setSidebarOpen(true)} className="text-gray-400 hover:text-white">
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/50" onClick={closeSidebar} />
      )}

      {/* Sidebar - desktop */}
      <aside className="hidden md:flex w-64 h-screen flex-shrink-0 bg-gray-900 dark:bg-gray-950 text-white flex-col border-r border-gray-800">
        {sidebar}
      </aside>

      {/* Sidebar - mobile */}
      <aside className={`md:hidden fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 dark:bg-gray-950 text-white flex flex-col transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {sidebar}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto pt-14 md:pt-0">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
