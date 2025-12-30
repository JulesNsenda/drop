/**
 * Remove Command
 *
 * Removes an application from DROP.
 */

import { Command } from 'commander';
import { RemoveOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createRemoveCommand(): Command {
  const cmd = new Command('remove')
    .alias('rm')
    .description('Remove an application')
    .argument('<app>', 'Application name')
    .option('-f, --force', 'Force removal without confirmation')
    .option('--keep-data', 'Keep application data and logs')
    .action(async (appName: string, options: RemoveOptions) => {
      try {
        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        // Warn if app is running
        if (status.status === 'online' && !options.force) {
          output.warn(`${appName} is currently running. Use --force to remove anyway.`);
          process.exit(1);
        }

        const spin = output.spinner(`Removing ${appName}...`);
        spin.start();

        // Stop if running
        if (status.status === 'online') {
          await processManager.stop(appName);
        }

        // Delete from PM2
        await processManager.delete(appName);

        spin.succeed(`Removed ${appName}`);

        if (!options.keepData) {
          output.info('Application data and logs have been preserved');
        }

        if (output.isJsonMode()) {
          output.json({ removed: appName, keepData: options.keepData ?? true });
        }

        resetProcessManager();
      } catch (err) {
        resetProcessManager();
        output.error('Failed to remove application', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
