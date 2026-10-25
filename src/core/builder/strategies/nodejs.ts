/**
 * Node.js Build Strategy
 *
 * Handles builds for Node.js applications including
 * Next.js, Nuxt, SvelteKit, Remix, Astro, Express, etc.
 */

import * as path from 'path';
import { BuildContext, DependencySettle } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';
import { NODE_RUNTIME_TYPES } from '../node-types';
import { checkTree, ensureFreshNodeModules, stampToolchain } from '../toolchain';
import {
  NODE_MODULES_DIR,
  hashTenantFile,
  readTenantText,
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
  supportedTypes: AppType[] = [...NODE_RUNTIME_TYPES];

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

  /**
   * Runs before the drop.yaml preBuild hooks and before preBuild's lockfile-hash
   * skip, outside its install guard: the production path (the Node detector's
   * `installCommand: 'npm install'`) never enters that guard. A node_modules
   * built for a different Node, or with no record of one, is moved aside here,
   * and its lockfile-hash marker moves with it, so the skip cannot resurrect it.
   * A failed move throws and fails the build. A Node app always ends up with a
   * JS install unless the skip fires. The returned handle is settled by the
   * builder.
   */
  async prepareDependencies(context: BuildContext): Promise<DependencySettle> {
    return ensureFreshNodeModules(context, true);
  }

  async preBuild(context: BuildContext): Promise<void> {
    const packageManager = await this.detectPackageManager(context.appPath);

    // Live only when installCommand is unset: the Node detector always supplies
    // `npm install` (detectors/nodejs.ts), so a detected Node app skips this
    // guard. The manifest detector supplies only `install.command` from
    // drop.yaml (detectors/manifest.ts), so a drop.yaml app WITHOUT `install:`
    // arrives here with it unset: for those this is the real install path.
    // The equivalent logic in strategies/static.ts is live for a source SPA, because
    // the static detector suggests no install command either.
    if (!context.config.installCommand) {
      // Prefer `npm ci` (or equivalent) when a lockfile exists — it's faster
      // and deterministic. Skip install only when the lockfile hash matches
      // the marker from the last successful install. The marker lives INSIDE
      // node_modules (see MARKER_NAME), so anything that destroys node_modules
      // — the monorepo re-copy, `npm ci`'s pre-clean — destroys the marker
      // with it, and a stale marker can never vouch for deps that are gone.
      const lockfileHash = await this.hashLockfile(context.appPath, packageManager);
      // With a known toolchain the skip also needs the tree to be stamped for
      // it, re-read HERE (after the drop.yaml hooks): a hook may have replaced
      // node_modules since the dependency step looked, and a matching lockfile
      // hash says nothing about which Node the tree was built for. An unknown id
      // keeps the skip as it was.
      const treeCurrent =
        !context.toolchainId ||
        (await checkTree(context.appPath, context.toolchainId)) === 'match';
      const storedHash =
        lockfileHash.kind === 'hash' && treeCurrent ? await this.readStoredHash(context) : null;

      if (lockfileHash.kind === 'hash' && treeCurrent && lockfileHash.value === storedHash) {
        context.config.skipInstall = true;
      } else {
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

    // Whenever this build will not skip its install (the skip above is the only
    // thing that sets it), any marker from an EARLIER install is stale the
    // moment this one starts: a failed yarn/pnpm install does not pre-clean
    // node_modules, and an absent or unhashable lockfile means no hash will be
    // written afterwards. With the marker gone, a successful postInstall is the
    // only way one exists, so an old marker can never match a later lockfile
    // and skip into this install's deps. Covers an install command that was
    // already set too, which never reaches the guard above.
    if (!context.config.skipInstall) {
      await this.invalidateMarkerBestEffort(context);
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
  async postInstall(context: BuildContext, deps?: DependencySettle): Promise<void> {
    // Stamp FIRST, then the lockfile hash, each in its own try: the builder
    // swallows a postInstall throw, so one failing must not skip the other. The
    // stamp is the one that matters for the ABI check.
    try {
      // After the install succeeded, the tree is current for this toolchain.
      await stampToolchain(context, this.getInstallCommand(context), deps);
    } catch {
      // Best-effort: an unstamped tree is left for the next install to reconcile.
    }
    try {
      const packageManager = await this.detectPackageManager(context.appPath);
      const hash = await this.hashLockfile(context.appPath, packageManager);
      // Only a hashable lockfile can be vouched for; preBuild already cleared
      // any older marker, so anything else leaves none behind.
      if (hash.kind === 'hash') {
        await this.writeStoredHash(context, hash.value);
      }
    } catch {
      // Best-effort: a missing hash only means the next build installs again.
    }
  }

  /**
   * Best-effort, unlike the toolchain wipe (ensureFreshNodeModules), which
   * throws: this marker is only a perf hint, so a failed removal never fails
   * the build.
   */
  private async invalidateMarkerBestEffort(context: BuildContext): Promise<void> {
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
    const read = await readTenantText(context.appPath, MARKER_REL, MAX_MARKER_BYTES);
    return read.kind === 'ok' ? read.text : null;
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
