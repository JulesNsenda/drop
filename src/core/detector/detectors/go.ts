/**
 * Go Detector
 *
 * Detects Go applications by analyzing go.mod, go.sum, and main files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, SuggestedConfig, GoMod } from '../detector.types';

// Common Go web framework modules
const FRAMEWORK_MODULES: Record<string, { framework: string; confidence: number }> = {
  'github.com/gin-gonic/gin': { framework: 'gin', confidence: 0.90 },
  'github.com/gofiber/fiber': { framework: 'fiber', confidence: 0.90 },
  'github.com/labstack/echo': { framework: 'echo', confidence: 0.90 },
  'github.com/gorilla/mux': { framework: 'gorilla', confidence: 0.85 },
  'github.com/go-chi/chi': { framework: 'chi', confidence: 0.85 },
  'github.com/beego/beego': { framework: 'beego', confidence: 0.85 },
  'github.com/julienschmidt/httprouter': { framework: 'httprouter', confidence: 0.80 },
};

export const goDetector: AppDetector = {
  name: 'go',
  priority: 75,

  async detect(appPath: string): Promise<DetectionResult | null> {
    const goModPath = path.join(appPath, 'go.mod');
    const goMod = await parseGoMod(goModPath);

    if (!goMod) {
      return null;
    }

    const warnings: string[] = [];
    let framework: string | null = null;
    let confidence = 0.80;
    let detectedBy = 'go.mod';

    // Check for known web frameworks
    for (const req of goMod.require) {
      const frameworkInfo = FRAMEWORK_MODULES[req.path];
      if (frameworkInfo && frameworkInfo.confidence > confidence) {
        framework = frameworkInfo.framework;
        confidence = frameworkInfo.confidence;
        detectedBy = `dependency:${req.path}`;
      }
    }

    // Check for main.go
    const hasMainGo = await fileExists(path.join(appPath, 'main.go'));
    const hasCmdDir = await fileExists(path.join(appPath, 'cmd'));

    if (!hasMainGo && !hasCmdDir) {
      warnings.push('No main.go or cmd/ directory found');
    }

    // Check for go.sum (indicates dependencies are resolved)
    const hasGoSum = await fileExists(path.join(appPath, 'go.sum'));
    if (!hasGoSum && goMod.require.length > 0) {
      warnings.push('go.sum not found - dependencies may need to be resolved');
    }

    const suggestedConfig = generateGoConfig(goMod, hasMainGo, hasCmdDir);

    return {
      type: 'go',
      framework,
      confidence,
      detectedBy,
      suggestedConfig,
      warnings,
      metadata: {
        module: goMod.module,
        goVersion: goMod.goVersion,
        dependencyCount: goMod.require.length,
      },
    };
  },
};

async function parseGoMod(filePath: string): Promise<GoMod | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    let module = '';
    let goVersion = '';
    const require: Array<{ path: string; version: string }> = [];
    let inRequireBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('module ')) {
        module = trimmed.substring(7).trim();
      } else if (trimmed.startsWith('go ')) {
        goVersion = trimmed.substring(3).trim();
      } else if (trimmed === 'require (') {
        inRequireBlock = true;
      } else if (trimmed === ')') {
        inRequireBlock = false;
      } else if (inRequireBlock && trimmed && !trimmed.startsWith('//')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          require.push({ path: parts[0], version: parts[1] });
        }
      } else if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
        // Single-line require
        const parts = trimmed.substring(8).trim().split(/\s+/);
        if (parts.length >= 2) {
          require.push({ path: parts[0], version: parts[1] });
        }
      }
    }

    if (!module) return null;

    return { module, goVersion, require };
  } catch {
    return null;
  }
}

function generateGoConfig(
  goMod: GoMod,
  hasMainGo: boolean,
  hasCmdDir: boolean
): SuggestedConfig {
  const config: SuggestedConfig = {};

  // Go apps compile to a binary - no install step needed
  // Build command: compile the binary
  const binaryName = goMod.module.split('/').pop() || 'app';

  if (hasMainGo) {
    config.buildCommand = `go build -o ${binaryName} .`;
  } else if (hasCmdDir) {
    config.buildCommand = `go build -o ${binaryName} ./cmd/...`;
  } else {
    config.buildCommand = `go build -o ${binaryName} .`;
  }

  // Start command runs the compiled binary
  const isWindows = process.platform === 'win32';
  config.startCommand = isWindows ? `${binaryName}.exe` : `./${binaryName}`;

  // Default port
  config.port = 8080;

  return config;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
