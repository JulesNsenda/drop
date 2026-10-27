/**
 * Every JSON store DROP keeps under `data/drop-svc/` must be in the backup
 * list, or `drop backup` silently omits it and `drop restore` forgets it.
 *
 * #301's object-storage stores were added without being added here, so a
 * restore would have forgotten every bucket. This pins the class of mistake:
 * the stores are DISCOVERED by scanning the source for `'<name>.json'`
 * literals in files that build `data/drop-svc` paths, so a new store that is
 * neither backed up nor consciously exempted fails here instead of in an
 * incident.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DROP_SVC_FILES } from './backup';

/**
 * Stores that predate this test and are NOT in DROP_SVC_FILES. Listed rather
 * than silently accepted: each is a decision for the maintainer (does a
 * restore overwrite it?), not something to fold into an unrelated change.
 * Remove an entry here when it is added to DROP_SVC_FILES.
 */
const NOT_BACKED_UP_YET = [
  'settings.json',
  'mail-credential.json',
  'deploys.json',
  'deploy-details.json',
  'principal-quotas.json',
  'mail-quotas.json',
  'invite-quotas.json',
  'app-guests.json',
  'app-guest-invites.json',
  'redis-allocations.json',
  // A one-shot migration flag: restoring it would skip a backfill that the
  // restored data may still need.
  'toolchain-backfill.json',
];

/** `.json` literals in the scanned files that are not drop-svc stores. */
const NOT_STORES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'tsconfig.json',
  'ormconfig.json',
  'nest-cli.json',
  'manifest.json',
  'composer.json',
  'drop.json',
  '.droprc.json',
  'meta.json',
  // Test-support and per-user credential files outside data/drop-svc.
  'credentials.json',
];

const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dashboard' || entry.name === '__testutils__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `'<name>.json'` literal in a non-test source file that mentions `drop-svc`. */
function discoverStoreNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    // latin1: platform.ts carries NUL bytes and mixed line endings.
    const text = fs.readFileSync(file).toString('latin1');
    if (!text.includes("'drop-svc'")) continue;
    for (const match of text.matchAll(/'([A-Za-z0-9._-]+\.json)'/g)) names.add(match[1]);
  }
  return names;
}

describe('data/drop-svc file stores vs the backup list', () => {
  const discovered = discoverStoreNames();

  it('backs up and restores the object-storage stores (#301)', () => {
    expect(DROP_SVC_FILES).toContain('object-storage.json');
    expect(DROP_SVC_FILES).toContain('object-storage-credential.json');
  });

  it('finds the stores it is meant to guard (the scan itself is not broken)', () => {
    for (const known of ['apps.json', 'secrets.json', 'object-storage.json', 'object-storage-credential.json']) {
      expect(discovered.has(known)).toBe(true);
    }
  });

  it('leaves no store out of the list unless it is consciously exempted', () => {
    const unaccounted = [...discovered]
      .filter((name) => !DROP_SVC_FILES.includes(name))
      .filter((name) => !NOT_BACKED_UP_YET.includes(name))
      .filter((name) => !NOT_STORES.includes(name))
      .sort();
    expect(unaccounted).toEqual([]);
  });

  it('keeps the exemption list honest: nothing exempted is already backed up or no longer exists', () => {
    expect(NOT_BACKED_UP_YET.filter((name) => DROP_SVC_FILES.includes(name))).toEqual([]);
    expect(NOT_BACKED_UP_YET.filter((name) => !discovered.has(name))).toEqual([]);
  });
});
