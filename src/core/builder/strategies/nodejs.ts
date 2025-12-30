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
    // Use custom install command if provided
    if (context.config.installCommand) {
      return context.config.installCommand;
    }

    // Detect package manager and return appropriate command
    // Note: This is sync for interface compatibility - we'll detect in preBuild
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
    // Detect package manager and update install command
    const packageManager = await this.detectPackageManager(context.appPath);

    if (!context.config.installCommand) {
      switch (packageManager) {
        case 'pnpm':
          context.config.installCommand = 'pnpm install';
          break;
        case 'yarn':
          context.config.installCommand = 'yarn install';
          break;
        default:
          context.config.installCommand = 'npm install';
      }
    }

    // Update build command if needed
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
