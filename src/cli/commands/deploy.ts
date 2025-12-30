/**
 * Deploy Command
 *
 * Deploys an application from a directory.
 */

import * as path from 'path';
import { Command } from 'commander';
import { DeployOptions } from '../cli.types';
import * as output from '../utils/output';
import { getDetector } from '../../core/detector';
import { getBuilder } from '../../core/builder';
import { getProcessManager, resetProcessManager } from '../../managers/process';

export function createDeployCommand(): Command {
  const cmd = new Command('deploy')
    .description('Deploy an application')
    .argument('[path]', 'Path to application directory', '.')
    .option('-n, --name <name>', 'Application name (defaults to directory name)')
    .option('-p, --port <port>', 'Port to run on', parseInt)
    .option('-e, --env <vars...>', 'Environment variables (KEY=VALUE)')
    .option('--no-build', 'Skip build step')
    .action(async (appPath: string, options: DeployOptions) => {
      try {
        // Resolve path
        const absolutePath = path.resolve(appPath);
        const appName = options.name || path.basename(absolutePath);

        output.info(`Deploying ${appName} from ${absolutePath}`);

        // Detect project type
        const detectSpin = output.spinner('Detecting project type...');
        detectSpin.start();

        const detector = getDetector();
        const detected = await detector.detect(absolutePath);

        if (!detected || detected.type === 'unknown') {
          detectSpin.fail('Could not detect project type');
          process.exit(1);
        }

        detectSpin.succeed(`Detected ${detected.type} project`);

        // Parse environment variables
        const env: Record<string, string> = {};
        if (options.env) {
          for (const envVar of options.env) {
            const [key, ...valueParts] = envVar.split('=');
            if (key && valueParts.length > 0) {
              env[key] = valueParts.join('=');
            }
          }
        }

        // Build if needed
        if (options.build !== false && detected.suggestedConfig?.buildCommand) {
          const buildSpin = output.spinner('Building application...');
          buildSpin.start();

          try {
            const builder = getBuilder();
            const buildResult = await builder.build({
              appName,
              appPath: absolutePath,
              appType: detected.type,
              framework: detected.framework || null,
              config: {
                buildCommand: detected.suggestedConfig.buildCommand,
                installCommand: detected.suggestedConfig.installCommand,
              },
              env,
            });

            if (!buildResult.success) {
              buildSpin.fail('Build failed');
              const errorMsg = buildResult.errors?.[0]?.message || 'Unknown build error';
              output.error(errorMsg);
              process.exit(1);
            }

            buildSpin.succeed(`Build completed in ${output.formatDuration(buildResult.duration)}`);
          } catch (err) {
            buildSpin.fail('Build failed');
            output.error('', err instanceof Error ? err : undefined);
            process.exit(1);
          }
        }

        // Start the application
        const startSpin = output.spinner('Starting application...');
        startSpin.start();

        try {
          const processManager = getProcessManager();
          const startCommand = detected.suggestedConfig?.startCommand || 'npm start';

          // Parse start command - extract script from "node <file>" format
          let script = startCommand;
          if (startCommand.startsWith('node ')) {
            script = startCommand.substring(5);
          }

          const status = await processManager.start({
            name: appName,
            script,
            cwd: absolutePath,
            port: options.port,
            env,
          });

          startSpin.succeed(`Application started (PID: ${status.pid})`);

          output.print('');
          output.success(`${appName} deployed successfully!`);

          if (options.port) {
            output.info(`Running on port ${options.port}`);
          }

          if (output.isJsonMode()) {
            output.json({
              name: appName,
              path: absolutePath,
              type: detected.type,
              status: status.status,
              pid: status.pid,
              port: options.port,
            });
          }

          resetProcessManager();
        } catch (err) {
          startSpin.fail('Failed to start application');
          resetProcessManager();
          output.error('', err instanceof Error ? err : undefined);
          process.exit(1);
        }
      } catch (err) {
        output.error('Deployment failed', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}
