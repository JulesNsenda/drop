/**
 * Start Command
 *
 * Starts a stopped application.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager } from '../../managers/process';

export function createStartCommand(): Command {
  const cmd = new Command('start')
    .description('Start an application')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Starting ${appName}...`);

      try {
        spin.start();

        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          spin.fail(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (status.status === 'online') {
          spin.succeed(`${appName} is already running`);
          return;
        }

        await processManager.restart(appName);
        const newStatus = await processManager.getStatus(appName);

        if (newStatus?.status === 'online') {
          spin.succeed(`Started ${appName} (PID: ${newStatus.pid})`);

          if (output.isJsonMode()) {
            output.json(newStatus);
          }
        } else {
          spin.fail(`Failed to start ${appName}`);
          process.exit(1);
        }
      } catch (err) {
        spin.fail(`Failed to start ${appName}`);
        output.error('', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
