/**
 * Serve Command
 *
 * Starts the DROP platform service.
 */

import { Command } from 'commander';
import * as path from 'path';
import * as output from '../utils/output';
import { DropPlatform } from '../../core/platform';
import * as pm2Client from '../../managers/process/pm2-client';

const DROP_SERVICE_NAME = 'drop-platform';

function printBanner(): void {
  output.print('');
  output.print('  ____  ____   ___  ____  ');
  output.print(' |  _ \\|  _ \\ / _ \\|  _ \\ ');
  output.print(' | | | | |_) | | | | |_) |');
  output.print(' | |_| |  _ <| |_| |  __/ ');
  output.print(' |____/|_| \\_\\\\___/|_|    ');
  output.print('');
  output.print(' Deploy, Run, Operate, Publish');
  output.print('');
}

async function startDaemon(options: {
  root?: string;
  watch?: string;
  domain?: string;
  https?: boolean;
  acmeEmail?: string;
  acmeStaging?: boolean;
  dnsProvider?: string;
  wildcard?: boolean;
}): Promise<void> {
  // Check if already running
  const status = await getDaemonStatus();
  if (status.running) {
    output.warn(`DROP is already running (PID: ${status.pid})`);
    output.info('Use "drop server stop" to stop it first.');
    return;
  }

  // Get the entry point for the serve command
  const scriptPath = path.resolve(__dirname, '../../index.js');
  const args: string[] = ['serve'];

  if (options.root) {
    args.push('--root', options.root);
  }
  if (options.watch) {
    args.push('--watch', options.watch);
  }
  if (options.domain) {
    args.push('--domain', options.domain);
  }
  if (options.https) {
    args.push('--https');
  }
  if (options.acmeEmail) {
    args.push('--acme-email', options.acmeEmail);
  }
  if (options.acmeStaging) {
    args.push('--acme-staging');
  }
  if (options.dnsProvider) {
    args.push('--dns-provider', options.dnsProvider);
  }
  if (options.wildcard) {
    args.push('--wildcard');
  }

  try {
    await pm2Client.start({
      name: DROP_SERVICE_NAME,
      script: scriptPath,
      args,
      cwd: process.cwd(),
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
    });

    output.success('DROP started as background service');
    output.print('');
    output.info(`Service name: ${DROP_SERVICE_NAME}`);
    output.print('');
    output.print('Commands:');
    output.print('  drop server status  - Check service status');
    output.print('  drop server stop    - Stop the service');
    output.print('  drop server logs    - View service logs');
    output.print('');
  } catch (err) {
    output.error('Failed to start DROP daemon', err instanceof Error ? err : undefined);
    throw err;
  } finally {
    pm2Client.disconnect();
  }
}

async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  uptime?: number;
  memory?: number;
  restarts?: number;
}> {
  try {
    const processes = await pm2Client.list();
    const dropProcess = processes.find((p) => p.name === DROP_SERVICE_NAME);

    if (!dropProcess || dropProcess.pm2_env?.status !== 'online') {
      return { running: false };
    }

    return {
      running: true,
      pid: dropProcess.pid,
      uptime: dropProcess.pm2_env?.pm_uptime
        ? Date.now() - dropProcess.pm2_env.pm_uptime
        : undefined,
      memory: dropProcess.monit?.memory,
      restarts: dropProcess.pm2_env?.restart_time,
    };
  } catch {
    return { running: false };
  }
}

export function createServeCommand(): Command {
  const cmd = new Command('serve')
    .description('Start the DROP platform service')
    .option('-d, --daemon', 'Run as background daemon')
    .option('-p, --port <port>', 'API port (not yet implemented)', '3000')
    .option('-w, --watch <dir>', 'Custom webapps directory')
    .option('-r, --root <dir>', 'Custom DROP root directory')
    .option('--domain <suffix>', 'Domain suffix (e.g., "example.com" for apps at myapp.example.com)')
    .option('--https', 'Enable HTTPS with Let\'s Encrypt')
    .option('--acme-email <email>', 'Email for Let\'s Encrypt notifications')
    .option('--acme-staging', 'Use Let\'s Encrypt staging environment (for testing)')
    .option('--dns-provider <provider>', 'DNS provider for wildcard certs (cloudflare, route53, digitalocean, godaddy)')
    .option('--wildcard', 'Use wildcard certificate (*.domain)')
    .action(async (options) => {
      try {
        printBanner();

        // Daemon mode
        if (options.daemon) {
          await startDaemon(options);
          return;
        }

        // Foreground mode
        const config: Record<string, unknown> = {};

        if (options.root) {
          config.dropRoot = options.root;
        }

        if (options.watch) {
          config.appsDirectory = options.watch;
        }

        // HTTPS and domain configuration
        if (options.domain) {
          config.domainSuffix = options.domain;
        }

        if (options.https) {
          config.enableHttps = true;
        }

        if (options.acmeEmail) {
          config.acmeEmail = options.acmeEmail;
        }

        if (options.acmeStaging) {
          config.acmeStaging = true;
        }

        if (options.dnsProvider) {
          config.dnsProvider = options.dnsProvider;
        }

        if (options.wildcard) {
          config.wildcardCert = true;
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
        output.print('Tip: Use "drop serve --daemon" to run as a background service.');
        output.print('');
      } catch (err) {
        output.error('Failed to start DROP', err instanceof Error ? err : undefined);
        process.exit(1);
      }
    });

  return cmd;
}

export function createServerCommand(): Command {
  const cmd = new Command('server').description('Manage DROP background service');

  cmd
    .command('status')
    .description('Check DROP service status')
    .action(async () => {
      try {
        const status = await getDaemonStatus();

        if (!status.running) {
          output.warn('DROP service is not running');
          output.print('');
          output.print('Start it with: drop serve --daemon');
          return;
        }

        output.success('DROP service is running');
        output.print('');
        output.print(`  PID:      ${status.pid}`);
        if (status.uptime !== undefined) {
          const uptimeSeconds = Math.floor(status.uptime / 1000);
          const hours = Math.floor(uptimeSeconds / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);
          const seconds = uptimeSeconds % 60;
          output.print(`  Uptime:   ${hours}h ${minutes}m ${seconds}s`);
        }
        if (status.memory !== undefined) {
          output.print(`  Memory:   ${Math.round(status.memory / 1024 / 1024)} MB`);
        }
        if (status.restarts !== undefined) {
          output.print(`  Restarts: ${status.restarts}`);
        }
        output.print('');
      } catch (err) {
        output.error('Failed to get status', err instanceof Error ? err : undefined);
      } finally {
        pm2Client.disconnect();
      }
    });

  cmd
    .command('stop')
    .description('Stop DROP service')
    .action(async () => {
      try {
        const status = await getDaemonStatus();

        if (!status.running) {
          output.warn('DROP service is not running');
          return;
        }

        await pm2Client.stop(DROP_SERVICE_NAME);
        await pm2Client.deleteProcess(DROP_SERVICE_NAME);

        output.success('DROP service stopped');
      } catch (err) {
        output.error('Failed to stop service', err instanceof Error ? err : undefined);
      } finally {
        pm2Client.disconnect();
      }
    });

  cmd
    .command('logs')
    .description('View DROP service logs')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .action(async (options) => {
      try {
        const status = await getDaemonStatus();

        if (!status.running) {
          output.warn('DROP service is not running');
          return;
        }

        // Use PM2 logs command directly
        const { spawn } = await import('child_process');
        const args = ['logs', DROP_SERVICE_NAME, '--lines', options.lines];
        if (!options.follow) {
          args.push('--nostream');
        }

        const pm2Path = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
        const child = spawn(pm2Path, args, {
          stdio: 'inherit',
          shell: true,
        });

        child.on('error', (err) => {
          output.error('Failed to show logs', err);
        });
      } catch (err) {
        output.error('Failed to get logs', err instanceof Error ? err : undefined);
      }
    });

  cmd
    .command('restart')
    .description('Restart DROP service')
    .action(async () => {
      try {
        const status = await getDaemonStatus();

        if (!status.running) {
          output.warn('DROP service is not running');
          output.print('Start it with: drop serve --daemon');
          return;
        }

        await pm2Client.restart(DROP_SERVICE_NAME);
        output.success('DROP service restarted');
      } catch (err) {
        output.error('Failed to restart service', err instanceof Error ? err : undefined);
      } finally {
        pm2Client.disconnect();
      }
    });

  return cmd;
}
