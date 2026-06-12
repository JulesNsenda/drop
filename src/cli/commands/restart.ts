/**
 * Restart Command
 *
 * Restarts an application via the DROP REST API.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createRestartCommand(): Command {
  const cmd = new Command('restart')
    .description('Restart an application')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Restarting ${appName}...`);

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

        await client.restartApp(appName);
        const updated = await client.getApp(appName).catch(() => null);

        if (updated?.status === 'running') {
          spin.succeed(`Restarted ${appName}${updated.pid ? ` (PID: ${updated.pid})` : ''}`);
          if (output.isJsonMode()) output.json(updated);
        } else {
          spin.fail(`Failed to restart ${appName}`);
          process.exit(1);
        }
      } catch (err) {
        spin.fail(`Failed to restart ${appName}`);
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
