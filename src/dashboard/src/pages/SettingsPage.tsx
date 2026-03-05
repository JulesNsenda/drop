import { useHealth } from '../hooks/useApi';
import { Server, Database, Eye, HardDrive } from 'lucide-react';

function SettingsPage() {
  const { health, loading } = useHealth();

  const formatUptime = (seconds?: number) => {
    if (!seconds) return 'Unknown';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-gray-500 dark:text-gray-400">Platform configuration and status</p>
      </div>

      {/* System Status */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">System Status</h2>
        </div>
        <div className="p-4">
          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
              <div className="h-4 w-36 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ) : health ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                  <Server className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Status</p>
                  <p className="font-medium text-green-600 dark:text-green-400 capitalize">{health.status}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <HardDrive className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Uptime</p>
                  <p className="font-medium text-gray-900 dark:text-white">{formatUptime(health.uptime)}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                  <Eye className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Watcher</p>
                  <p className="font-medium text-gray-900 dark:text-white capitalize">{health.components?.watcher || 'Unknown'}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                  <Database className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Database</p>
                  <p className="font-medium text-gray-900 dark:text-white capitalize">{health.components?.database || 'Unknown'}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">Unable to fetch system status</p>
          )}
        </div>
      </div>

      {/* Configuration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">Configuration</h2>
        </div>
        <div className="p-4">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Version</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white">{health?.version || '0.4.0'}</td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Apps Directory</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white">
                  {navigator.platform.includes('Win')
                    ? 'C:\\drop\\data\\webapps'
                    : '/var/drop/data/webapps'}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">Config Directory</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white">
                  {navigator.platform.includes('Win')
                    ? 'C:\\drop\\data\\appconf\\webapps'
                    : '/var/drop/data/appconf/webapps'}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-gray-500 dark:text-gray-400">API Endpoint</td>
                <td className="py-2 font-mono text-gray-900 dark:text-white">http://localhost:3000/api/v1</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* About */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-white">About DROP</h2>
        </div>
        <div className="p-4">
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            DROP (Deploy, Run, Operate, Publish) is a lightweight, self-hosted PaaS for
            zero-configuration deployments. Drop a folder and get a running application.
          </p>
          <div className="flex gap-4">
            <a
              href="https://github.com/JulesNsenda/drop"
              target="_blank"
              rel="noopener noreferrer"
              className="text-drop-600 hover:underline"
            >
              GitHub Repository
            </a>
            <a
              href="https://github.com/JulesNsenda/drop/blob/main/CHANGELOG.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-drop-600 hover:underline"
            >
              Changelog
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
