/**
 * Logs Command
 *
 * View application logs via the DROP REST API.
 */

import { Command } from 'commander';
import { LogsOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('View application logs')
    .argument('<app>', 'Application name')
    .option('-n, --lines <number>', 'Number of lines to show', '100')
    .option('-e, --error', 'Show only error logs')
    .option('-f, --follow', 'Follow log output in real-time')
    .action(async (appName: string, options: LogsOptions) => {
      try {
        const client = await createApiClient();

        // Verify the app exists before streaming/fetching
        const app = await client.getApp(appName).catch((err) => {
          if (err instanceof DropApiError && err.statusCode === 404) return null;
          throw err;
        });

        if (!app) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (options.follow) {
          output.info(`Following logs for ${appName}... (Ctrl+C to stop)`);
          output.print('');

          const stop = await client.streamLogs(
            appName,
            (line) => {
              if (options.error && !line.startsWith('[err]')) return;
              if (line.startsWith('[err]')) {
                output.print(output.color(`[ERR] ${line.replace('[err] ', '')}`, 'red'));
              } else {
                output.print(line.replace('[out] ', ''));
              }
            },
            (err) => {
              output.error('Log stream error', err);
            }
          );

          const cleanup = (): void => {
            stop();
            output.print('');
            output.info('Stopped following logs');
            process.exit(0);
          };
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
          return;
        }

        const lines = parseInt(String(options.lines || '100'), 10);
        const logLines = await client.getLogs(appName, lines);

        if (logLines.length === 0) {
          output.info('No logs available');
          return;
        }

        const filtered = options.error ? logLines.filter((l) => l.startsWith('[err]')) : logLines;

        if (output.isJsonMode()) {
          output.json({ app: appName, lines: filtered });
        } else {
          for (const line of filtered) {
            if (line.startsWith('[err]')) {
              output.print(output.color(line, 'red'));
            } else if (line.startsWith('[out]')) {
              output.print(line.replace('[out] ', ''));
            } else {
              output.print(line);
            }
          }
        }
      } catch (err) {
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('Failed to get logs', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
