/**
 * Remove Command
 *
 * Removes an application from DROP via the REST API.
 */

import { Command } from 'commander';
import { RemoveOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createRemoveCommand(): Command {
  const cmd = new Command('remove')
    .alias('rm')
    .description('Remove an application')
    .argument('<app>', 'Application name')
    .option('-f, --force', 'Force removal without confirmation')
    .option('--keep-data', 'Keep application data and logs')
    .action(async (appName: string, options: RemoveOptions) => {
      try {
        const client = await createApiClient();
        const app = await client.getApp(appName).catch((err) => {
          if (err instanceof DropApiError && err.statusCode === 404) return null;
          throw err;
        });

        if (!app) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (app.status === 'running' && !options.force) {
          output.warn(`${appName} is currently running. Use --force to remove anyway.`);
          process.exit(1);
        }

        const spin = output.spinner(`Removing ${appName}...`);
        spin.start();

        const result = await client.removeApp(appName, { keepData: options.keepData });

        spin.succeed(`Removed ${appName}`);

        switch (result.database) {
          case 'preserved':
            output.info("Kept the app's database (--keep-data).");
            break;
          case 'dropped':
            output.info(
              "Backed up and dropped the app's database (dump retained ~3 days under data/backup/pre-delete)."
            );
            break;
          case 'retained':
            output.warn("Could not drop the database — it was left intact (see server logs).");
            break;
          case 'none':
          default:
            // No database was provisioned for this app — nothing to report.
            break;
        }

        if (output.isJsonMode()) {
          output.json({ removed: appName, keepData: options.keepData ?? false, database: result.database });
        }
      } catch (err) {
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('Failed to remove application', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
