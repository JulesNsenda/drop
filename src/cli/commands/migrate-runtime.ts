/**
 * Migrate Runtime Command (M2e)
 *
 * Moves an app from its current runtime (PM2 or Docker) to the target runtime.
 * Stops the existing process/container, updates the per-app config, and
 * triggers a redeploy so the platform restarts the app in the new runtime.
 *
 * Usage:
 *   drop migrate-runtime <app>            # → docker (default)
 *   drop migrate-runtime <app> --to pm2  # → pm2
 */

import { Command } from 'commander';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createMigrateRuntimeCommand(): Command {
  return new Command('migrate-runtime')
    .description('Migrate an app between PM2 and Docker runtimes')
    .argument('<app>', 'Application name')
    .option('--to <runtime>', 'Target runtime: docker or pm2', 'docker')
    .action(async (appName: string, options: { to: string }) => {
      const targetRuntime = options.to === 'pm2' ? 'pm2' : 'docker';

      const spin = output.spinner(
        `Migrating ${appName} to ${targetRuntime} runtime...`
      );

      try {
        spin.start();

        const client = await createApiClient();
        const result = await client.migrateRuntime(appName, targetRuntime);

        const detail = result.redeploying
          ? `Redeploying as ${result.to}...`
          : `App is stopped. Run 'drop start ${appName}' when ready.`;

        spin.succeed(`${appName}: ${result.from} → ${result.to}. ${detail}`);

        if (output.isJsonMode()) {
          output.json(result);
        }
      } catch (err) {
        spin.fail(`Failed to migrate ${appName}`);
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });
}
