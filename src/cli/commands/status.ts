/**
 * Status Command
 *
 * Shows detailed status of an application.
 */

import { Command } from 'commander';
import { GlobalOptions } from '../cli.types';
import * as output from '../utils/output';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createStatusCommand(): Command {
  const cmd = new Command('status')
    .description('Show application status')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: GlobalOptions) => {
      try {
        const processManager = getProcessManager();
        const status = await processManager.getStatus(appName);

        if (!status) {
          output.error(`Application not found: ${appName}`);
          process.exit(1);
        }

        if (output.isJsonMode()) {
          output.json(status);
        } else {
          output.print('');
          output.print(`${output.color('Application:', 'bold')} ${status.name}`);
          output.print(`${output.color('Status:', 'bold')}      ${output.formatStatus(status.status)}`);
          output.print(`${output.color('Mode:', 'bold')}        ${status.execMode}`);
          output.print(`${output.color('Instances:', 'bold')}   ${status.instances}`);
          output.print('');
          output.print(output.color('Process Info:', 'bold'));
          output.print(`  PID:        ${status.pid ?? 'N/A'}`);
          output.print(`  PM2 ID:     ${status.pmId ?? 'N/A'}`);
          output.print(`  Restarts:   ${status.restarts}`);
          output.print(`  Uptime:     ${status.uptime ? output.formatDuration(status.uptime) : 'N/A'}`);
          output.print('');
          output.print(output.color('Resources:', 'bold'));
          output.print(`  Memory:     ${output.formatBytes(status.memory)}`);
          output.print(`  CPU:        ${status.cpu.toFixed(1)}%`);
          output.print('');

          if (status.createdAt) {
            output.print(output.color('Timestamps:', 'bold'));
            output.print(`  Created:    ${status.createdAt.toISOString()}`);
            if (status.restartedAt) {
              output.print(`  Restarted:  ${status.restartedAt.toISOString()}`);
            }
            output.print('');
          }
        }

        resetProcessManager();
      } catch (err) {
        resetProcessManager();
        output.error('Failed to get application status', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
