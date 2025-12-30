/**
 * Node.js Detector
 *
 * Detects Node.js applications and their frameworks by analyzing
 * package.json and config files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, PackageJson, AppType, SuggestedConfig } from '../detector.types';

// Framework config files and their types
const FRAMEWORK_CONFIG_FILES: Record<string, { type: AppType; framework: string; confidence: number }> = {
  'next.config.js': { type: 'nextjs', framework: 'next', confidence: 0.95 },
  'next.config.mjs': { type: 'nextjs', framework: 'next', confidence: 0.95 },
  'next.config.ts': { type: 'nextjs', framework: 'next', confidence: 0.95 },
  'nuxt.config.js': { type: 'nuxt', framework: 'nuxt', confidence: 0.95 },
  'nuxt.config.ts': { type: 'nuxt', framework: 'nuxt', confidence: 0.95 },
  'svelte.config.js': { type: 'sveltekit', framework: 'sveltekit', confidence: 0.95 },
  'remix.config.js': { type: 'remix', framework: 'remix', confidence: 0.95 },
  'astro.config.mjs': { type: 'astro', framework: 'astro', confidence: 0.95 },
  'astro.config.ts': { type: 'astro', framework: 'astro', confidence: 0.95 },
  'nest-cli.json': { type: 'nest', framework: 'nestjs', confidence: 0.95 },
};

// Dependency to framework mapping
const DEPENDENCY_FRAMEWORKS: Record<string, { type: AppType; framework: string; confidence: number }> = {
  'next': { type: 'nextjs', framework: 'next', confidence: 0.85 },
  'nuxt': { type: 'nuxt', framework: 'nuxt', confidence: 0.85 },
  '@sveltejs/kit': { type: 'sveltekit', framework: 'sveltekit', confidence: 0.85 },
  'remix': { type: 'remix', framework: 'remix', confidence: 0.80 },
  '@remix-run/node': { type: 'remix', framework: 'remix', confidence: 0.85 },
  'astro': { type: 'astro', framework: 'astro', confidence: 0.85 },
  '@nestjs/core': { type: 'nest', framework: 'nestjs', confidence: 0.85 },
  'express': { type: 'express', framework: 'express', confidence: 0.75 },
  'fastify': { type: 'fastify', framework: 'fastify', confidence: 0.80 },
  'hono': { type: 'hono', framework: 'hono', confidence: 0.80 },
  'koa': { type: 'nodejs', framework: 'koa', confidence: 0.75 },
};

export const nodejsDetector: AppDetector = {
  name: 'nodejs',
  priority: 80,

  async detect(appPath: string): Promise<DetectionResult | null> {
    const packageJsonPath = path.join(appPath, 'package.json');
    const packageJson = await readPackageJson(packageJsonPath);

    if (!packageJson) {
      return null;
    }

    const warnings: string[] = [];
    let type: AppType = 'nodejs';
    let framework: string | null = null;
    let confidence = 0.70;
    let detectedBy = 'package.json';

    // Check for framework config files first (highest confidence)
    for (const [configFile, info] of Object.entries(FRAMEWORK_CONFIG_FILES)) {
      const configPath = path.join(appPath, configFile);
      if (await fileExists(configPath)) {
        type = info.type;
        framework = info.framework;
        confidence = info.confidence;
        detectedBy = `config:${configFile}`;
        break;
      }
    }

    // If no config file found, check dependencies
    if (type === 'nodejs' && packageJson.dependencies) {
      for (const [dep, info] of Object.entries(DEPENDENCY_FRAMEWORKS)) {
        if (packageJson.dependencies[dep] || packageJson.devDependencies?.[dep]) {
          if (info.confidence > confidence) {
            type = info.type;
            framework = info.framework;
            confidence = info.confidence;
            detectedBy = `dependency:${dep}`;
          }
        }
      }
    }

    // Generate suggested config
    const suggestedConfig = generateNodeConfig(packageJson, type, framework);

    // Check for common issues
    if (!packageJson.scripts?.start && type !== 'static') {
      warnings.push('No "start" script found in package.json');
    }

    if (!packageJson.scripts?.build && needsBuild(type)) {
      warnings.push('No "build" script found in package.json');
    }

    if (!packageJson.engines?.node) {
      warnings.push('No Node.js version specified in engines field');
    }

    return {
      type,
      framework,
      confidence,
      detectedBy,
      suggestedConfig,
      warnings,
      metadata: {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        scripts: packageJson.scripts,
        nodeVersion: packageJson.engines?.node,
      },
    };
  },
};

async function readPackageJson(filePath: string): Promise<PackageJson | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PackageJson;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function generateNodeConfig(
  packageJson: PackageJson,
  type: AppType,
  framework: string | null
): SuggestedConfig {
  const config: SuggestedConfig = {
    installCommand: 'npm install',
  };

  // Determine build command
  if (packageJson.scripts?.build) {
    config.buildCommand = 'npm run build';
  }

  // Determine start command - always use the actual script file for PM2 compatibility
  // Parse the start script or use the main entry point
  config.startCommand = getActualStartScript(packageJson, type, framework);

  // Determine output directory
  config.outputDirectory = getOutputDirectory(type, framework);

  // Default port
  config.port = getDefaultPort(type, framework);

  // Node version
  if (packageJson.engines?.node) {
    config.nodeVersion = packageJson.engines.node;
  }

  return config;
}

/**
 * Get the actual script file to run, parsing npm scripts if needed.
 * This is needed because PM2 on Windows cannot run npm directly.
 */
function getActualStartScript(
  packageJson: PackageJson,
  type: AppType,
  _framework: string | null
): string {
  // First, try to parse the start script if it exists
  if (packageJson.scripts?.start) {
    const startScript = packageJson.scripts.start;

    // If the script is "node <file>", extract the file
    if (startScript.startsWith('node ')) {
      return startScript; // Return as-is, e.g., "node server.js"
    }

    // If it's just a file reference like "server.js"
    if (startScript.endsWith('.js') || startScript.endsWith('.mjs') || startScript.endsWith('.ts')) {
      return `node ${startScript}`;
    }
  }

  // Fall back to main entry point
  if (packageJson.main) {
    return `node ${packageJson.main}`;
  }

  // Framework-specific defaults
  switch (type) {
    case 'nextjs':
      return 'node node_modules/next/dist/bin/next start';
    case 'nuxt':
      return 'node .output/server/index.mjs';
    case 'sveltekit':
      return 'node build';
    case 'astro':
      return 'node ./dist/server/entry.mjs';
    case 'nest':
      return 'node dist/main.js';
    default:
      return 'node index.js';
  }
}

function getOutputDirectory(type: AppType, _framework: string | null): string | undefined {
  switch (type) {
    case 'nextjs':
      return '.next';
    case 'nuxt':
      return '.output';
    case 'sveltekit':
      return 'build';
    case 'remix':
      return 'build';
    case 'astro':
      return 'dist';
    case 'nest':
      return 'dist';
    default:
      return undefined;
  }
}

function getDefaultPort(type: AppType, _framework: string | null): number {
  switch (type) {
    case 'nextjs':
      return 3000;
    case 'nuxt':
      return 3000;
    case 'sveltekit':
      return 3000;
    case 'remix':
      return 3000;
    case 'astro':
      return 4321;
    default:
      return 3000;
  }
}

function needsBuild(type: AppType): boolean {
  const buildRequired: AppType[] = ['nextjs', 'nuxt', 'sveltekit', 'remix', 'astro', 'nest'];
  return buildRequired.includes(type);
}
