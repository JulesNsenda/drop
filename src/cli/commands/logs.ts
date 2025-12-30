/**
 * Logs Command
 *
 * View application logs.
 */

import { Command } from 'commander';
import { LogsOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('View application logs')
    .argument('<app>', 'Application name')
    .option('-n, --lines <number>', 'Number of lines to show', '100')
    .option('-e, --error', 'Show only error logs')
    .option('-f, --follow', 'Follow log output in real-time')
    .action(async (appName: string, options: LogsOptions) => {
      try {
        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        // If follow mode, stream logs
        if (options.follow) {
          output.info(`Following logs for ${appName}... (Ctrl+C to stop)`);
          output.print('');

          const stopStreaming = await processManager.streamLogs(
            appName,
            (line, type) => {
              // Filter for errors if requested
              if (options.error && type !== 'err') {
                return;
              }

              if (type === 'err') {
                output.print(output.color(`[ERR] ${line}`, 'red'));
              } else {
                output.print(`[OUT] ${line}`);
              }
            },
            (error) => {
              output.error('Log stream error', error);
            }
          );

          // Handle graceful shutdown
          const cleanup = (): void => {
            stopStreaming();
            resetProcessManager();
            output.print('');
            output.info('Stopped following logs');
            process.exit(0);
          };

          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);

          // Keep the process running
          return;
        }

        // Non-follow mode: show last N lines
        const lines = parseInt(String(options.lines || '100'), 10);
        const logs = await processManager.getLogs(appName, lines);

        if (!logs) {
          output.info('No logs available');
          resetProcessManager();
          return;
        }

        // Filter for errors if requested
        let logLines = logs.split('\n');
        if (options.error) {
          logLines = logLines.filter(line => line.startsWith('[err]'));
        }

        if (output.isJsonMode()) {
          output.json({
            app: appName,
            lines: logLines,
          });
        } else {
          for (const line of logLines) {
            if (line.startsWith('[err]')) {
              output.print(output.color(line, 'red'));
            } else if (line.startsWith('[out]')) {
              output.print(line.replace('[out] ', ''));
            } else {
              output.print(line);
            }
          }
        }

        resetProcessManager();
      } catch (err) {
        resetProcessManager();
        output.error('Failed to get logs', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
