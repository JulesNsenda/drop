/**
 * List Command
 *
 * Lists all deployed applications.
 */

import { Command } from 'commander';
import { ListOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List all applications')
    .option('-s, --status <status>', 'Filter by status (online, stopped, errored)')
    .option('-a, --all', 'Show all apps including stopped')
    .action(async (options: ListOptions) => {
      try {
        const processManager = getProcessManager();
        const processes = await processManager.getAllStatus();

        // Filter by status if specified
        let filtered = processes;
        if (options.status) {
          filtered = processes.filter(p => p.status === options.status);
        } else if (!options.all) {
          // By default, show only online processes
          filtered = processes.filter(p => p.status === 'online');
        }

        // Convert to AppInfo (with port)
        const apps = filtered.map(p => ({
          name: p.name,
          status: p.status,
          type: p.execMode,
          port: p.port,
          pid: p.pid ?? undefined,
          memory: p.memory,
          cpu: p.cpu,
          uptime: p.uptime,
          restarts: p.restarts,
        }));

        if (apps.length === 0) {
          if (output.isJsonMode()) {
            output.json([]);
          } else {
            output.info('No applications found');
          }
          resetProcessManager();
          return;
        }

        if (output.isJsonMode()) {
          output.json(apps);
        } else {
          output.table(
            [
              { header: 'NAME', key: 'name', width: 20 },
              { header: 'STATUS', key: 'statusFormatted', width: 10 },
              { header: 'PORT', key: 'portStr', width: 6, align: 'right' },
              { header: 'PID', key: 'pidStr', width: 8, align: 'right' },
              { header: 'MEMORY', key: 'memoryStr', width: 10, align: 'right' },
              { header: 'CPU', key: 'cpuStr', width: 6, align: 'right' },
              { header: 'UPTIME', key: 'uptimeStr', width: 10, align: 'right' },
            ],
            apps.map(app => ({
              ...app,
              statusFormatted: output.formatStatus(app.status),
              portStr: app.port ?? '-',
              pidStr: app.pid ?? '-',
              memoryStr: app.memory ? output.formatBytes(app.memory) : '-',
              cpuStr: app.cpu !== undefined ? `${app.cpu.toFixed(1)}%` : '-',
              uptimeStr: app.uptime ? output.formatDuration(app.uptime) : '-',
            }))
          );
        }

        // Disconnect from PM2 to allow process to exit
        resetProcessManager();
      } catch (err) {
        resetProcessManager();
        output.error('Failed to list applications', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
