/**
 * DROP - Deploy, Run, Operate, Publish
 *
 * Main entry point for the DROP platform service.
 */

import { DropPlatform } from './core/platform';

async function main(): Promise<void> {
  const platform = new DropPlatform();

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    await platform.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await platform.start();
    console.log('DROP platform started successfully');
  } catch (error) {
    console.error('Failed to start DROP platform:', error);
    process.exit(1);
  }
}

main();
