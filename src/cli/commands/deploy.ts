/**
 * Deploy Command
 *
 * Registers an application with the DROP platform, which handles
 * detection, build, and startup through its own pipeline.
 *
 * For git sources the folder is cloned directly into the webapps directory
 * so the watcher picks it up automatically (no API call needed).
 */

import * as path from 'path';
import { Command } from 'commander';
import { DeployOptions } from '../cli.types';
import * as output from '../utils/output';
import { createApiClient, DropApiError } from '../api-client';
import { getGitDeployService } from '../../core/git-deploy';

function getWebappsDir(): string {
  return process.env.DROP_APPS_DIR ??
    (process.platform === 'win32' ? 'C:\\drop\\data\\webapps' : '/var/drop/data/webapps');
}

export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy an application')
    .argument('[path]', 'Path to application directory', '.')
    .option('-n, --name <name>', 'Application name (defaults to directory name)')
    .option('-p, --port <port>', 'Port to run on', parseInt)
    .option('-e, --env <vars...>', 'Environment variables (KEY=VALUE)')
    .option('--no-build', 'Skip build step')
    .option('-g, --git <url>', 'Deploy from a GitHub repository URL')
    .option('-b, --branch <branch>', 'Git branch to deploy (default: main)')
    .action(async (appPath: string, options: DeployOptions) => {
      try {
        // Git deploy: clone into the webapps dir; watcher handles build+start
        if (options.git) {
          const spin = output.spinner('Cloning repository...');
          spin.start();

          try {
            const gitService = getGitDeployService({
              appsDirectory: path.resolve(getWebappsDir()),
            });
            await gitService.initialize();

            const result = await gitService.deploy({
              repoUrl: options.git,
              branch: options.branch || 'main',
              name: options.name,
            });

            spin.succeed(`Cloned ${result.repoUrl} (${result.branch})`);
            output.success(`${result.appName} deployed from GitHub!`);
            output.info(`Commit: ${result.commitSha?.slice(0, 7) || 'unknown'}`);
            output.info('The platform will auto-detect, build, and start the app.');

            if (output.isJsonMode()) output.json(result);
          } catch (err) {
            spin.fail('Git deploy failed');
            output.error('', err instanceof Error ? err : undefined);
            process.exit(1);
          }
          return;
        }

        // Local deploy: register the path with the platform; it handles the rest
        const absolutePath = path.resolve(appPath);
        const appName = options.name || path.basename(absolutePath);

        const spin = output.spinner(`Registering ${appName} with the platform...`);
        spin.start();

        try {
          const client = await createApiClient();
          const app = await client.deployApp(absolutePath, appName, options.port);

          spin.succeed(`${appName} registered — platform is building and starting it`);
          output.print('');
          output.success(`${appName} deployment queued`);
          output.info(`Run 'drop status ${appName}' to check progress`);
          output.info(`Run 'drop logs ${appName}' to watch the build`);

          if (app.port) output.info(`Will run on port ${app.port}`);

          if (output.isJsonMode()) output.json(app);
        } catch (err) {
          spin.fail('Deployment failed');
          if (err instanceof DropApiError) {
            output.error(err.message);
          } else {
            output.error('', err instanceof Error ? err : undefined);
          }
          process.exit(1);
        }
      } catch (err) {
        output.error('Deployment failed', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
