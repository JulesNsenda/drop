/**
 * Node.js Build Strategy
 *
 * Handles builds for Node.js applications including
 * Next.js, Nuxt, SvelteKit, Remix, Astro, Express, etc.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';

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
      // node_modules (see markerPath), so anything that destroys node_modules
      // — the monorepo re-copy, `npm ci`'s pre-clean — destroys the marker
      // with it, and a stale marker can never vouch for deps that are gone.
      const lockfileHash = await this.hashLockfile(context.appPath, packageManager);
      const storedHash = await this.readStoredHash(context);

      if (lockfileHash && lockfileHash === storedHash) {
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
            // Use `npm ci` when a lockfile is present, `npm install` otherwise
            context.config.installCommand = lockfileHash ? 'npm ci' : 'npm install';
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
    if (hash) {
      await this.writeStoredHash(context, hash);
    }
  }

  /**
   * The install-skip marker sits inside node_modules on purpose: its validity
   * is exactly node_modules' lifetime. Never create node_modules for it —
   * that would fabricate the evidence the marker stands for.
   */
  private markerPath(context: BuildContext): string {
    return path.join(context.appPath, 'node_modules', '.drop-lockfile-hash');
  }

  private async hashLockfile(
    appPath: string,
    pm: 'npm' | 'yarn' | 'pnpm'
  ): Promise<string | null> {
    const lockfiles: Record<string, string> = {
      npm: 'package-lock.json',
      yarn: 'yarn.lock',
      pnpm: 'pnpm-lock.yaml',
    };
    const lockfilePath = path.join(appPath, lockfiles[pm]);
    try {
      const content = await fsp.readFile(lockfilePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  private async readStoredHash(context: BuildContext): Promise<string | null> {
    try {
      return (await fsp.readFile(this.markerPath(context), 'utf-8')).trim();
    } catch {
      return null;
    }
  }

  private async writeStoredHash(context: BuildContext, hash: string): Promise<void> {
    try {
      // No mkdir: if install didn't produce node_modules there is nothing to
      // vouch for, and the write fails closed (next build installs again).
      await fsp.writeFile(this.markerPath(context), hash, 'utf-8');
    } catch {
      // Best-effort; a missing hash just means next build won't skip
    }
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
