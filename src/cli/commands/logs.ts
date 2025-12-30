/**
 * Logs Command
 *
 * View application logs.
 */

import { Command } from 'commander';
import { LogsOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager } from '../../managers/process';

export function createLogsCommand(): Command {
  const cmd = new Command('logs')
    .description('View application logs')
    .argument('<app>', 'Application name')
    .option('-n, --lines <number>', 'Number of lines to show', '100')
    .option('-e, --error', 'Show only error logs')
    .option('-f, --follow', 'Follow log output (not implemented yet)')
    .action(async (appName: string, options: LogsOptions) => {
      try {
        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        const lines = parseInt(String(options.lines || '100'), 10);
        const logs = await processManager.getLogs(appName, lines);

        if (!logs) {
          output.info('No logs available');
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

        if (options.follow) {
          output.warn('Follow mode (-f) is not yet implemented');
        }
      } catch (err) {
        output.error('Failed to get logs', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
