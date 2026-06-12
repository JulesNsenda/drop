/**
 * List Command
 *
 * Lists deployed applications via the DROP REST API.
 */

import { Command } from 'commander';
import { ListOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createListCommand(): Command {
  const cmd = new Command('list')
    .alias('ls')
    .description('List all applications')
    .option('-s, --status <status>', 'Filter by status (running, stopped, errored)')
    .option('-a, --all', 'Show all apps including stopped')
    .action(async (options: ListOptions) => {
      try {
        const client = await createApiClient();

        // Normalize legacy 'online' filter to the DROP-owned 'running' value
        let statusFilter = options.status === 'online' ? 'running' : options.status;

        // Default: show only running apps unless --all or --status given
        if (!options.all && !statusFilter) {
          statusFilter = 'running';
        }

        const apps = await client.listApps(options.all ? {} : { status: statusFilter });

        if (apps.length === 0) {
          if (output.isJsonMode()) {
            output.json([]);
          } else {
            output.info('No applications found');
          }
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
              { header: 'RESTARTS', key: 'restartsStr', width: 9, align: 'right' },
            ],
            apps.map((app) => ({
              ...app,
              statusFormatted: output.formatStatus(app.status),
              portStr: app.port ?? '-',
              pidStr: app.pid ?? '-',
              memoryStr: app.memory ? output.formatBytes(app.memory) : '-',
              cpuStr: app.cpu !== undefined ? `${app.cpu.toFixed(1)}%` : '-',
              restartsStr: app.restarts ?? '-',
            }))
          );
        }
      } catch (err) {
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('Failed to list applications', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
