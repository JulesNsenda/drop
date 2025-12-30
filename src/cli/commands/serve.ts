/**
 * Serve Command
 *
 * Starts the DROP platform service.
 */

import { Command } from 'commander';
import * as output from '../utils/output';
import { DropPlatform } from '../../core/platform';

export function createServeCommand(): Command {
  const cmd = new Command('serve')
    .description('Start the DROP platform service')
    .option('-p, --port <port>', 'API port (not yet implemented)', '3000')
    .option('-w, --watch <dir>', 'Custom webapps directory')
    .option('-r, --root <dir>', 'Custom DROP root directory')
    .action(async (options) => {
      try {
        output.print('');
        output.print('  ____  ____   ___  ____  ');
        output.print(' |  _ \\|  _ \\ / _ \\|  _ \\ ');
        output.print(' | | | | |_) | | | | |_) |');
        output.print(' | |_| |  _ <| |_| |  __/ ');
        output.print(' |____/|_| \\_\\\\___/|_|    ');
        output.print('');
        output.print(' Deploy, Run, Operate, Publish');
        output.print('');

        const config: Record<string, string> = {};

        if (options.root) {
          config.dropRoot = options.root;
        }

        if (options.watch) {
          config.appsDirectory = options.watch;
        }

        const platform = new DropPlatform(config);

        // Handle graceful shutdown
        const shutdown = async (signal: string): Promise<void> => {
          output.print('');
          output.info(`Received ${signal}, shutting down...`);
          await platform.stop();
          output.success('DROP stopped. Goodbye!');
          process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        await platform.start();

        output.print('');
        output.success('DROP is running!');
        output.print('');
        output.info(`Watching: ${platform.getConfig().appsDirectory}`);
        output.print('');
        output.print('To deploy an app, copy it to the webapps directory.');
        output.print('Press Ctrl+C to stop.');
        output.print('');
      } catch (err) {
        output.error('Failed to start DROP', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
