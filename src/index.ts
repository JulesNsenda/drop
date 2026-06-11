/**
 * DROP - Deploy, Run, Operate, Publish
 *
 * Main entry point for the DROP platform service. This is what the daemon
 * (drop serve -d) launches via PM2, so it must honor the same flags the CLI
 * forwards (--root, --domain, --https, ...). Plain `node dist/index.js` and
 * systemd units pass no args and fall back to env/defaults unchanged.
 */

import { DropPlatform, PlatformConfig } from './core/platform';
import { IsolationMode } from './core/startup-constraints';

/** Parse the subset of CLI flags the daemon forwards into a PlatformConfig. */
export function parseArgs(argv: string[]): Partial<PlatformConfig> {
  const config: Partial<PlatformConfig> = {};

  const valueOf = (i: number): string | undefined => {
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--root': {
        const v = valueOf(i);
        if (v) config.dropRoot = v;
        break;
      }
      case '--watch': {
        const v = valueOf(i);
        if (v) config.appsDirectory = v;
        break;
      }
      case '--domain': {
        const v = valueOf(i);
        if (v) config.domainSuffix = v;
        break;
      }
      case '--https':
        config.enableHttps = true;
        break;
      case '--acme-email': {
        const v = valueOf(i);
        if (v) config.acmeEmail = v;
        break;
      }
      case '--acme-staging':
        config.acmeStaging = true;
        break;
      case '--dns-provider': {
        const v = valueOf(i);
        if (v) config.dnsProvider = v as PlatformConfig['dnsProvider'];
        break;
      }
      case '--wildcard':
        config.wildcardCert = true;
        break;
      case '--isolation': {
        const v = valueOf(i);
        if (v === 'none' || v === 'docker') config.isolation = v as IsolationMode;
        break;
      }
      case '--allow-signup':
        config.allowSignup = true;
        break;
      default:
        // Ignore unknown tokens (e.g. the leading "serve").
        break;
    }
  }

  return config;
}

async function main(): Promise<void> {
  const platform = new DropPlatform(parseArgs(process.argv.slice(2)));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully...`);

    // Bound the shutdown so a hung dependency (e.g. an unresponsive Postgres)
    // can't wedge the process forever.
    const timer = setTimeout(() => {
      console.error('Shutdown timed out after 30s, forcing exit');
      process.exit(1);
    }, 30_000);
    timer.unref?.();

    try {
      await platform.stop();
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A long-running service must not die on a stray rejection/exception. Log
  // loudly; let PM2's autorestart recover if the process is truly unhealthy.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });

  try {
    await platform.start();
    console.log('DROP platform started successfully');
  } catch (error) {
    console.error('Failed to start DROP platform:', error);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported, e.g. by tests).
if (require.main === module) {
  main();
}
