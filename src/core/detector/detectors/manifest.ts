/**
 * Manifest Detector
 *
 * Detects applications that have an explicit drop.yaml or drop.json manifest.
 * This takes highest priority with confidence 1.0.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { AppDetector, DetectionResult, DropManifest, AppType } from '../detector.types';

const MANIFEST_FILES = ['drop.yaml', 'drop.yml', 'drop.json', '.droprc', '.droprc.json', '.droprc.yaml'];

export const manifestDetector: AppDetector = {
  name: 'manifest',
  priority: 100, // Highest priority

  async detect(appPath: string): Promise<DetectionResult | null> {
    for (const file of MANIFEST_FILES) {
      const filePath = path.join(appPath, file);
      const manifest = await readManifest(filePath);

      if (manifest) {
        const warnings: string[] = [];

        // Validate manifest
        if (!manifest.type) {
          warnings.push('Manifest missing "type" field, will attempt auto-detection for type');
        }

        if (!manifest.start?.command && !manifest.build?.command) {
          warnings.push('Manifest missing both start and build commands');
        }

        return {
          type: manifest.type || 'unknown',
          framework: manifest.framework || null,
          confidence: 1.0,
          detectedBy: `manifest:${file}`,
          suggestedConfig: {
            buildCommand: manifest.build?.command,
            startCommand: manifest.start?.command,
            installCommand: manifest.install?.command,
            outputDirectory: manifest.build?.output,
            port: manifest.port,
            env: manifest.env,
            database: manifest.database,
          },
          warnings,
          metadata: {
            manifestFile: file,
            manifest,
          },
        };
      }
    }

    return null;
  },
};

async function readManifest(filePath: string): Promise<DropManifest | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json' || filePath.endsWith('.droprc.json')) {
      return JSON.parse(content) as DropManifest;
    }

    if (ext === '.yaml' || ext === '.yml' || filePath.endsWith('.droprc.yaml')) {
      return yaml.parse(content) as DropManifest;
    }

    // Try JSON first for .droprc
    try {
      return JSON.parse(content) as DropManifest;
    } catch {
      return yaml.parse(content) as DropManifest;
    }
  } catch {
    return null;
  }
}

export function validateManifest(manifest: DropManifest): string[] {
  const errors: string[] = [];

  if (manifest.type && !isValidAppType(manifest.type)) {
    errors.push(`Invalid app type: ${manifest.type}`);
  }

  if (manifest.port && (manifest.port < 1 || manifest.port > 65535)) {
    errors.push(`Invalid port: ${manifest.port}`);
  }

  return errors;
}

function isValidAppType(type: string): type is AppType {
  const validTypes: AppType[] = [
    'nodejs', 'nextjs', 'nuxt', 'sveltekit', 'remix', 'astro',
    'express', 'fastify', 'hono', 'nest',
    'static', 'spa',
    'python', 'django', 'flask', 'fastapi',
    'go', 'rust', 'php', 'docker', 'proxy', 'unknown',
  ];
  return validTypes.includes(type as AppType);
}
