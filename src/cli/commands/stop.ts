/**
 * Stop Command
 *
 * Stops a running application via the DROP REST API.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createStopCommand(): Command {
  const cmd = new Command('stop')
    .description('Stop an application')
    .argument('<app>', 'Application name')
    .option('-f, --force', 'Force stop without confirmation')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Stopping ${appName}...`);

      try {
        spin.start();

        const client = await createApiClient();
        const app = await client.getApp(appName).catch((err) => {
          if (err instanceof DropApiError && err.statusCode === 404) return null;
          throw err;
        });

        if (!app) {
          spin.fail(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (app.status === 'stopped') {
          spin.succeed(`${appName} is already stopped`);
          return;
        }

        await client.stopApp(appName);
        spin.succeed(`Stopped ${appName}`);

        if (output.isJsonMode()) {
          const updated = await client.getApp(appName).catch(() => null);
          output.json(updated ?? { name: appName, status: 'stopped' });
        }
      } catch (err) {
        spin.fail(`Failed to stop ${appName}`);
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
