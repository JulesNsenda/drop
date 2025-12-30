/**
 * Stop Command
 *
 * Stops a running application.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createStopCommand(): Command {
  const cmd = new Command('stop')
    .description('Stop an application')
    .argument('<app>', 'Application name')
    .option('-f, --force', 'Force stop without confirmation')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Stopping ${appName}...`);

      try {
        spin.start();

        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          spin.fail(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (status.status === 'stopped') {
          spin.succeed(`${appName} is already stopped`);
          resetProcessManager();
          return;
        }

        await processManager.stop(appName);

        spin.succeed(`Stopped ${appName}`);

        if (output.isJsonMode()) {
          const newStatus = await processManager.getStatus(appName);
          output.json(newStatus);
        }

        resetProcessManager();
      } catch (err) {
        spin.fail(`Failed to stop ${appName}`);
        resetProcessManager();
        output.error('', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
