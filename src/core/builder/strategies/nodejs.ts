/**
 * Node.js Build Strategy
 *
 * Handles builds for Node.js applications including
 * Next.js, Nuxt, SvelteKit, Remix, Astro, Express, etc.
 */

import * as path from 'path';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';
import {
  NODE_MODULES_DIR,
  hashTenantFile,
  readTenantFile,
  removeTenantPath,
  writeTenantFile,
} from '../../../utils/tenant-file';

// The install-skip marker sits inside node_modules on purpose: its validity is
// exactly node_modules' lifetime. Never create node_modules for it — that would
// fabricate the evidence the marker stands for.
const MARKER_NAME = '.drop-lockfile-hash';
const MARKER_REL = path.join(NODE_MODULES_DIR, MARKER_NAME);

// Absent lockfile: `npm install`. Unhashable (symlink, FIFO, oversize, any
// other refusal): `npm ci`, never a skip, and no marker is written. Hash: the
// skip-if-unchanged path.
type LockfileHash = { kind: 'absent' } | { kind: 'unhashable' } | { kind: 'hash'; value: string };

// A sha256 hex digest is 64 bytes; anything much bigger is not our marker.
const MAX_MARKER_BYTES = 256;

// Generous: real lockfiles run to a few MB, a huge monorepo's to tens. The cap
// only exists so a tenant cannot make the platform buffer a gigabyte to hash.
const MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;

// Framework-specific output directories
const OUTPUT_DIRECTORIES: Record<string, string> = {
  nextjs: '.next',
  nuxt: '.output',
  sveltekit: 'build',
  remix: 'build',
  astro: 'dist',
  nest: 'dist',
  express: 'dist',
  fastify: 'dist',
  hono: 'dist',
  nodejs: 'dist',
};

// Frameworks that require a build step
const REQUIRES_BUILD: AppType[] = [
  'nextjs',
  'nuxt',
  'sveltekit',
  'remix',
  'astro',
  'nest',
];

export class NodejsBuildStrategy extends BaseBuildStrategy {
  name = 'nodejs';
  supportedTypes: AppType[] = [
    'nodejs',
    'nextjs',
    'nuxt',
    'sveltekit',
    'remix',
    'astro',
    'express',
    'fastify',
    'hono',
    'nest',
  ];

  getInstallCommand(context: BuildContext): string | null {
    if (context.config.skipInstall) return null;
    if (context.config.installCommand) return context.config.installCommand;
    return 'npm install';
  }

  getBuildCommand(context: BuildContext): string | null {
    // Use custom build command if provided
    if (context.config.buildCommand) {
      return context.config.buildCommand;
    }

    // Some app types don't need a build step
    if (!REQUIRES_BUILD.includes(context.appType)) {
      return null;
    }

    return 'npm run build';
  }

  getOutputDirectory(context: BuildContext): string | null {
    // Use custom output directory if provided
    if (context.config.outputDirectory) {
      return context.config.outputDirectory;
    }

    return OUTPUT_DIRECTORIES[context.appType] || null;
  }

  async preBuild(context: BuildContext): Promise<void> {
    const packageManager = await this.detectPackageManager(context.appPath);

    // DEAD IN THE DEFAULT PATH: the Node detector always supplies
    // installCommand: 'npm install' (see detectors/nodejs.ts), so this guard
    // is false for every detected Node app and none of the branches below
    // run. The equivalent logic in strategies/static.ts IS live, because the
    // static detector suggests no install command. Do not "fix" a bug in here
    // without first removing the detector's suggestion.
    if (!context.config.installCommand) {
      // Prefer `npm ci` (or equivalent) when a lockfile exists — it's faster
      // and deterministic. Skip install only when the lockfile hash matches
      // the marker from the last successful install. The marker lives INSIDE
      // node_modules (see MARKER_NAME), so anything that destroys node_modules
      // — the monorepo re-copy, `npm ci`'s pre-clean — destroys the marker
      // with it, and a stale marker can never vouch for deps that are gone.
      const lockfileHash = await this.hashLockfile(context.appPath, packageManager);
      const storedHash =
        lockfileHash.kind === 'hash' ? await this.readStoredHash(context) : null;

      if (lockfileHash.kind === 'hash' && lockfileHash.value === storedHash) {
        context.config.skipInstall = true;
      } else {
        // The install is about to run, so any marker from an EARLIER install
        // is stale the moment it starts: a failed yarn/pnpm install does not
        // pre-clean node_modules, and an absent or unhashable lockfile means
        // no hash will be written afterwards. With the marker gone, a
        // successful postInstall is the only way one exists, so an old marker
        // can never match a later lockfile and skip into this install's deps.
        await this.invalidateMarker(context);
        switch (packageManager) {
          case 'pnpm':
            context.config.installCommand = 'pnpm install --frozen-lockfile';
            break;
          case 'yarn':
            context.config.installCommand = 'yarn install --frozen-lockfile';
            break;
          default:
            // Use `npm ci` when a lockfile is present (even one we cannot
            // hash), `npm install` only when there is none.
            context.config.installCommand =
              lockfileHash.kind === 'absent' ? 'npm install' : 'npm ci';
        }
        // The hash is persisted in postInstall, after the install succeeds.
      }
    }

    if (!context.config.buildCommand && REQUIRES_BUILD.includes(context.appType)) {
      switch (packageManager) {
        case 'pnpm':
          context.config.buildCommand = 'pnpm run build';
          break;
        case 'yarn':
          context.config.buildCommand = 'yarn build';
          break;
        default:
          context.config.buildCommand = 'npm run build';
      }
    }
  }

  /**
   * Persist the lockfile hash only after the install stage succeeded (the
   * builder calls this for successful, non-skipped installs). Hashing here —
   * rather than reusing preBuild's hash — also captures a lockfile that the
   * install itself created or updated (`npm install` without a prior lockfile).
   */
  async postInstall(context: BuildContext): Promise<void> {
    const packageManager = await this.detectPackageManager(context.appPath);
    const hash = await this.hashLockfile(context.appPath, packageManager);
    // Only a hashable lockfile can be vouched for; preBuild already cleared
    // any older marker, so anything else leaves none behind.
    if (hash.kind === 'hash') {
      await this.writeStoredHash(context, hash.value);
    }
  }

  private async invalidateMarker(context: BuildContext): Promise<void> {
    try {
      await removeTenantPath(context.appPath, MARKER_REL);
    } catch {
      // Best-effort. A failure (e.g. EACCES on a node_modules the tenant made
      // read-only) can leave a stale marker behind, so a later build may skip
      // its install. Only the tenant's own build is affected, and the tenant
      // can write the marker anyway: it is a cache hint, not an integrity check.
    }
  }

  private async hashLockfile(
    appPath: string,
    pm: 'npm' | 'yarn' | 'pnpm'
  ): Promise<LockfileHash> {
    const lockfiles: Record<string, string> = {
      npm: 'package-lock.json',
      yarn: 'yarn.lock',
      pnpm: 'pnpm-lock.yaml',
    };
    // The lockfile is tenant-authored and, under docker isolation, was last
    // touched by tenant code on a shared bind mount. Nothing there is "no
    // lockfile" (install runs unpinned); anything there we refuse to read is
    // a lockfile we cannot vouch for, which must never read as a skip.
    const hashed = await hashTenantFile(appPath, lockfiles[pm], MAX_LOCKFILE_BYTES);
    if (hashed.kind === 'absent') return { kind: 'absent' };
    if (hashed.kind === 'refused') return { kind: 'unhashable' };
    return { kind: 'hash', value: hashed.sha256 };
  }

  private async readStoredHash(context: BuildContext): Promise<string | null> {
    const read = await readTenantFile(
      context.appPath,
      MARKER_REL,
      MAX_MARKER_BYTES
    );
    return read.kind === 'ok' ? read.content.toString('utf-8').trim() : null;
  }

  private async writeStoredHash(context: BuildContext, hash: string): Promise<void> {
    // Best-effort; a refused write just means next build installs again.
    await writeTenantFile(context.appPath, MARKER_REL, hash);
  }

  async validate(context: BuildContext, outputPath: string): Promise<boolean> {
    // For frameworks without build output, just check package.json exists
    if (!REQUIRES_BUILD.includes(context.appType)) {
      return this.fileExists(path.join(context.appPath, 'package.json'));
    }

    // Check if output directory exists
    const fullOutputPath = path.join(context.appPath, outputPath);
    return this.fileExists(fullOutputPath);
  }
}

export const nodejsBuildStrategy = new NodejsBuildStrategy();
