/**
 * Start Command
 *
 * Starts a stopped application via the DROP REST API.
 */

import { Command } from 'commander';
import { ProcessOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createStartCommand(): Command {
  const cmd = new Command('start')
    .description('Start an application')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: ProcessOptions) => {
      const spin = output.spinner(`Starting ${appName}...`);

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

        if (app.status === 'running') {
          spin.succeed(`${appName} is already running`);
          return;
        }

        await client.startApp(appName);
        const updated = await client.getApp(appName).catch(() => null);

        if (updated?.status === 'running') {
          spin.succeed(`Started ${appName}${updated.pid ? ` (PID: ${updated.pid})` : ''}`);
          if (output.isJsonMode()) output.json(updated);
        } else {
          spin.fail(`Failed to start ${appName}`);
          process.exit(1);
        }
      } catch (err) {
        spin.fail(`Failed to start ${appName}`);
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
