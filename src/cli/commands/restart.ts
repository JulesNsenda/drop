/**
 * Restart Command
 *
 * Restarts an application.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createRestartCommand(): Command {
  const cmd = new Command('restart')
    .description('Restart an application')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Restarting ${appName}...`);

      try {
        spin.start();

        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          spin.fail(`Application not found: ${appName}`);
          process.exit(1);
        }

        await processManager.restart(appName);
        const newStatus = await processManager.getStatus(appName);

        if (newStatus?.status === 'online') {
          spin.succeed(`Restarted ${appName} (PID: ${newStatus.pid})`);

          if (output.isJsonMode()) {
            output.json(newStatus);
          }
        } else {
          spin.fail(`Failed to restart ${appName}`);
          resetProcessManager();
          process.exit(1);
        }

        resetProcessManager();
      } catch (err) {
        spin.fail(`Failed to restart ${appName}`);
        resetProcessManager();
        output.error('', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
