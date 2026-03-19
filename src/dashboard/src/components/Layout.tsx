import { Outlet, NavLink } from 'react-router-dom';
import { LayoutGrid, Settings, Box, Upload, Sun, Moon, Monitor, LogOut, User } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';

function Layout() {
  const { theme, setTheme } = useTheme();
  const { authRequired, username, logout } = useAuth();

  const themeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const ThemeIcon = themeIcon;
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const themeLabel = theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System';

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-900">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 dark:bg-gray-950 text-white flex flex-col border-r border-gray-800">
        {/* Logo */}
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-drop-500 rounded-lg flex items-center justify-center">
              <Box className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-lg">DROP</h1>
              <p className="text-xs text-gray-400">Dashboard</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            <li>
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-drop-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`
                }
              >
                <LayoutGrid className="w-5 h-5" />
                Applications
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/deploy"
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-drop-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`
                }
              >
                <Upload className="w-5 h-5" />
                Deploy
              </NavLink>
            </li>
            <li>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                    isActive
                      ? 'bg-drop-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`
                }
              >
                <Settings className="w-5 h-5" />
                Settings
              </NavLink>
            </li>
          </ul>
        </nav>

        {/* Footer controls */}
        <div className="p-4 border-t border-gray-800 space-y-3">
          {/* Theme toggle */}
          <button
            onClick={() => setTheme(nextTheme)}
            className="flex items-center gap-3 w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            title={`Theme: ${themeLabel}`}
          >
            <ThemeIcon className="w-4 h-4" />
            <span>{themeLabel}</span>
          </button>

          {/* User menu */}
          {authRequired && (
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <User className="w-4 h-4" />
                <span className="truncate">{username || 'User'}</span>
              </div>
              <button
                onClick={logout}
                className="text-gray-500 hover:text-white transition-colors"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="text-xs text-gray-600 px-3">DROP v0.4.0</div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
