#!/usr/bin/env node
/**
 * DROP CLI Entry Point
 *
 * Command-line interface for the DROP PaaS platform.
 */

import { Command } from 'commander';
import { setJsonMode, setQuietMode, error } from './utils/output';
import {
  createVersionCommand,
  createListCommand,
  createStatusCommand,
  createLogsCommand,
  createStartCommand,
  createStopCommand,
  createRestartCommand,
  createDeployCommand,
  createRemoveCommand,
  createServeCommand,
  createServerCommand,
  createBackupCommand,
  createMigrateRuntimeCommand,
  createMfaCommand,
} from './commands';
import { getPlatformVersion } from '../utils/version';

const VERSION = getPlatformVersion();

/**
 * Create the main CLI program
 */
function createProgram(): Command {
  const program = new Command();

  program
    .name('drop')
    .description('DROP - Deploy, Run, Operate, Publish')
    .version(VERSION, '-v, --version', 'Show version number')
    .option('-j, --json', 'Output in JSON format')
    .option('-q, --quiet', 'Suppress non-error output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts.json) {
        setJsonMode(true);
      }
      if (opts.quiet) {
        setQuietMode(true);
      }
    });

  // Add commands
  program.addCommand(createServeCommand());
  program.addCommand(createServerCommand());
  program.addCommand(createDeployCommand());
  program.addCommand(createListCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createLogsCommand());
  program.addCommand(createStartCommand());
  program.addCommand(createStopCommand());
  program.addCommand(createRestartCommand());
  program.addCommand(createRemoveCommand());
  program.addCommand(createBackupCommand());
  program.addCommand(createMigrateRuntimeCommand());
  program.addCommand(createMfaCommand());
  program.addCommand(createVersionCommand());

  // Error handling
  program.configureOutput({
    writeErr: (str) => {
      error(str.trim());
    },
  });

  return program;
}

/**
 * Run the CLI
 */
async function main(): Promise<void> {
  const program = createProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    error('An unexpected error occurred', err instanceof Error ? err : undefined);
    process.exit(1);
  }
}

// Export for testing
export { createProgram };

// Run if called directly
if (require.main === module) {
  main();
}
