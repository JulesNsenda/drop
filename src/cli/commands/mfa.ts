/**
 * MFA Recovery Command
 *
 * `drop mfa disable <username>` — admin recovery hatch when a user has lost
 * their TOTP device. Edits api-credentials.json directly and refuses to run
 * while the DROP server is up (to avoid clobbering in-memory state).
 */

import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import { writeJsonAtomic } from '../../utils/atomic-write';
import * as output from '../utils/output';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const DEFAULT_API_PORT = 3000;

function resolveDropRoot(rootOpt?: string): string {
  return rootOpt || process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
}

/** Returns true if something is listening on the given port. */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export function createMfaCommand(): Command {
  const mfa = new Command('mfa').description('MFA administration (recovery commands)');

  mfa
    .command('disable <username>')
    .description('Disable TOTP for a user (recovery: use when the user has lost their device)')
    .option('-r, --root <path>', 'DROP root directory')
    .option('--port <port>', 'API port to check for running server', String(DEFAULT_API_PORT))
    .option('--force', 'Skip the running-server check (dangerous — only use if you know the server is stopped)')
    .action(async (username: string, opts: { root?: string; port: string; force?: boolean }) => {
      const dropRoot = resolveDropRoot(opts.root);
      const credPath = path.join(dropRoot, 'data', 'drop-svc', 'api-credentials.json');
      const apiPort = parseInt(opts.port, 10) || DEFAULT_API_PORT;

      // Safety: refuse to run while the server is up
      if (!opts.force) {
        const serverRunning = await isPortOpen(apiPort);
        if (serverRunning) {
          output.error(
            `DROP server appears to be running on port ${apiPort}.\n` +
            `Stop the server first (e.g. 'sudo systemctl stop drop-platform') then retry.\n` +
            `Use --force to skip this check only if you are certain the server is stopped.`
          );
          process.exit(1);
        }
      }

      // Read credentials
      let store: { users?: Array<{ id: string; username: string; mfaEnabled?: boolean; mfaSecret?: unknown; mfaLastUsedStep?: number }> };
      try {
        const raw = await fs.readFile(credPath, 'utf-8');
        store = JSON.parse(raw);
      } catch (err) {
        output.error(`Could not read credentials file at ${credPath}: ${err}`);
        process.exit(1);
      }

      const users = store.users ?? [];
      const user = users.find((u) => u.username === username);

      if (!user) {
        output.error(`User '${username}' not found in credentials store.`);
        process.exit(1);
      }

      if (!user.mfaEnabled) {
        output.info(`MFA is not enabled for '${username}' — nothing to do.`);
        process.exit(0);
      }

      // Wipe MFA fields
      delete user.mfaEnabled;
      delete user.mfaSecret;
      delete user.mfaLastUsedStep;

      try {
        await writeJsonAtomic(credPath, store, { mode: 0o600 });
        output.success(`MFA disabled for user '${username}'.`);
        output.info(`The user can now log in with their password alone.`);
      } catch (err) {
        output.error(`Failed to write credentials: ${err}`);
        process.exit(1);
      }
    });

  return mfa;
}
