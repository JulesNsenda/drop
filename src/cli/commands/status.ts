/**
 * Status Command
 *
 * Shows detailed status of an application via the DROP REST API.
 */

import { Command } from 'commander';
import { GlobalOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';

export function createStatusCommand(): Command {
  const cmd = new Command('status')
    .description('Show application status')
    .argument('<app>', 'Application name')
    .action(async (appName: string, _options: GlobalOptions) => {
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

        if (output.isJsonMode()) {
          output.json(app);
        } else {
          output.print('');
          output.print(`${output.color('Application:', 'bold')} ${app.name}`);
          output.print(`${output.color('Status:', 'bold')}      ${output.formatStatus(app.status)}`);
          output.print(`${output.color('Type:', 'bold')}        ${app.type}${app.framework ? ` (${app.framework})` : ''}`);
          if (app.hostname) {
            output.print(`${output.color('Hostname:', 'bold')}    ${app.hostname}`);
          }
          if (app.customDomain) {
            output.print(`${output.color('Domain:', 'bold')}      ${app.customDomain}`);
          }
          output.print('');
          output.print(output.color('Process Info:', 'bold'));
          output.print(`  Port:       ${app.port ?? 'N/A'}`);
          output.print(`  PID:        ${app.pid ?? 'N/A'}`);
          output.print(`  Restarts:   ${app.restarts ?? 'N/A'}`);
          if (app.memory !== undefined) {
            output.print(`  Memory:     ${output.formatBytes(app.memory)}`);
          }
          if (app.cpu !== undefined) {
            output.print(`  CPU:        ${app.cpu.toFixed(1)}%`);
          }
          if (app.error) {
            output.print('');
            output.print(output.color('Error:', 'bold'));
            output.print(`  ${app.error}`);
          }
          output.print('');
          if (app.createdAt) {
            output.print(output.color('Timestamps:', 'bold'));
            output.print(`  Created:    ${app.createdAt}`);
            if (app.lastDeployedAt) {
              output.print(`  Deployed:   ${app.lastDeployedAt}`);
            }
            if (app.buildDuration !== undefined) {
              output.print(`  Build time: ${output.formatDuration(app.buildDuration)}`);
            }
            output.print('');
          }
        }
      } catch (err) {
        if (err instanceof DropApiError) {
          output.error(err.message);
        } else {
          output.error('Failed to get application status', err instanceof Error ? err : undefined);
        }
        process.exit(1);
      }
    });

  return cmd;
}
