/**
 * Static Site Detector
 *
 * Detects static HTML/CSS/JS sites and SPAs.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, AppType, SuggestedConfig } from '../detector.types';

// Common static site indicators
const STATIC_FILES = ['index.html', 'index.htm'];
const SPA_INDICATORS = ['manifest.json', 'service-worker.js', 'sw.js'];
const BUILD_OUTPUT_DIRS = ['dist', 'build', 'public', 'out', '_site', 'www'];

export const staticDetector: AppDetector = {
  name: 'static',
  priority: 30, // Lower priority - should be a fallback

  async detect(appPath: string): Promise<DetectionResult | null> {
    const warnings: string[] = [];
    let type: AppType = 'static';
    let confidence = 0.50;
    let detectedBy = 'static-files';
    let servePath = appPath;

    // Check for index.html in root
    const hasRootIndex = await hasIndexFile(appPath);

    // Check for index.html in common build output directories
    let buildDir: string | null = null;
    for (const dir of BUILD_OUTPUT_DIRS) {
      const dirPath = path.join(appPath, dir);
      if (await hasIndexFile(dirPath)) {
        buildDir = dir;
        servePath = dirPath;
        break;
      }
    }

    if (!hasRootIndex && !buildDir) {
      return null;
    }

    // Determine confidence and type
    if (buildDir) {
      confidence = 0.70;
      detectedBy = `build-dir:${buildDir}`;
    } else if (hasRootIndex) {
      confidence = 0.60;
      detectedBy = 'root-index.html';
    }

    // Check for SPA indicators
    const isSpa = await checkForSpaIndicators(servePath);
    if (isSpa) {
      type = 'spa';
      confidence += 0.10;
      detectedBy = `${detectedBy}+spa-indicators`;
    }

    // Generate suggested config
    const suggestedConfig = generateStaticConfig(servePath, appPath, buildDir, isSpa);

    // Check for common issues
    if (!buildDir && await hasPackageJson(appPath)) {
      warnings.push('Found package.json but serving from root - may need to build first');
    }

    const fileCount = await countStaticFiles(servePath);
    if (fileCount > 1000) {
      warnings.push(`Large number of files (${fileCount}) - consider optimizing`);
    }

    return {
      type,
      framework: isSpa ? 'spa' : 'vanilla',
      confidence,
      detectedBy,
      suggestedConfig,
      warnings,
      metadata: {
        hasRootIndex,
        buildDir,
        isSpa,
        servePath: path.relative(appPath, servePath) || '.',
        fileCount,
      },
    };
  },
};

async function hasIndexFile(dirPath: string): Promise<boolean> {
  for (const file of STATIC_FILES) {
    try {
      await fs.access(path.join(dirPath, file));
      return true;
    } catch {
      // Continue checking
    }
  }
  return false;
}

async function checkForSpaIndicators(dirPath: string): Promise<boolean> {
  for (const file of SPA_INDICATORS) {
    try {
      await fs.access(path.join(dirPath, file));
      return true;
    } catch {
      // Continue checking
    }
  }

  // Check index.html for SPA framework indicators
  try {
    const indexPath = path.join(dirPath, 'index.html');
    const content = await fs.readFile(indexPath, 'utf-8');

    // Look for common SPA patterns
    const spaPatterns = [
      '<div id="root"',
      '<div id="app"',
      'type="module"',
      'noscript',
      '__NEXT_DATA__',
      '__NUXT__',
    ];

    for (const pattern of spaPatterns) {
      if (content.includes(pattern)) {
        return true;
      }
    }
  } catch {
    // Ignore errors
  }

  return false;
}

async function hasPackageJson(appPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(appPath, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

async function countStaticFiles(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    return entries.filter(e => e.isFile()).length;
  } catch {
    return 0;
  }
}

function generateStaticConfig(
  _servePath: string,
  _appPath: string,
  buildDir: string | null,
  isSpa: boolean
): SuggestedConfig {
  const config: SuggestedConfig = {
    port: 8080,
  };

  // Output directory is where we serve from
  if (buildDir) {
    config.outputDirectory = buildDir;
  }

  // For SPAs, we need to handle client-side routing
  if (isSpa) {
    config.env = {
      SPA_FALLBACK: 'true',
    };
  }

  return config;
}
