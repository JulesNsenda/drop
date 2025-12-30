/**
 * Version Command
 *
 * Shows DROP version information.
 */

import { Command } from 'commander';
import * as output from '../utils/output';

// Version from package.json
const VERSION = '0.1.0-alpha.1';

export function createVersionCommand(): Command {
  const cmd = new Command('version')
    .description('Show DROP version')
    .action(() => {
      if (output.isJsonMode()) {
        output.json({
          name: 'drop',
          version: VERSION,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        });
      } else {
        output.print(`DROP v${VERSION}`);
        output.print(`Node ${process.version}`);
        output.print(`${process.platform} ${process.arch}`);
      }
    });

  return cmd;
}
