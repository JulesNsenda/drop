/**
 * Remove Command
 *
 * Removes an application from DROP via the REST API.
 */

import { Command } from 'commander';
import { RemoveOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';
import { ask, isInteractiveTerminal } from '../utils/prompt';

export function createRemoveCommand(): Command {
  const cmd = new Command('remove')
    .alias('rm')
    .description('Remove an application')
    .argument('<app>', 'Application name')
    .option('-f, --force', 'Force removal without confirmation')
    .option('--keep-data', 'Keep application data and logs')
    .option(
      '--destroy-bucket',
      "Also permanently delete the app's object-storage bucket and every object in it (no backup)"
    )
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

        // Destroying a bucket is a person's decision: it is typed at a terminal,
        // never passed from a script (a pipe, cron, an agent). The server
        // accepts this CLI's key for it, so this prompt is the check that a
        // human is there.
        if (options.destroyBucket) {
          if (!isInteractiveTerminal()) {
            output.error(
              '--destroy-bucket permanently deletes data and has to be confirmed by a person: run it from an interactive terminal, or delete the app from the dashboard. It cannot be confirmed from a script.'
            );
            process.exit(1);
          }
          const typed = await ask(
            `This permanently deletes ${appName}'s object-storage bucket and every object in it, with no backup.\nType the app name to confirm: `
          );
          if (typed !== appName) {
            output.error('The name did not match, so nothing was deleted.');
            process.exit(1);
          }
        }

        const spin = output.spinner(`Removing ${appName}...`);
        spin.start();

        const result = await client.removeApp(appName, {
          keepData: options.keepData,
          destroyBucket: options.destroyBucket,
        });

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
          // The server refuses to delete a bucket without an explicit say-so;
          // say which two ways forward there are.
          if (err.details?.reason === 'confirmation-required') {
            output.info(
              isInteractiveTerminal()
                ? `${appName} holds an object-storage bucket. To delete the app and KEEP the bucket, re-run with --keep-data. ` +
                    'To delete the app AND permanently destroy the bucket and every object in it (no backup), re-run with --destroy-bucket and type the app name when asked.'
                : `${appName} holds an object-storage bucket. To delete the app and keep the bucket, re-run with --keep-data. ` +
                    'Destroying the bucket has to be confirmed by a person, interactively, in the dashboard or at a terminal.'
            );
          }
        } else {
          output.error('Failed to remove application', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
