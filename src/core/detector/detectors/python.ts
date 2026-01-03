/**
 * Python Detector
 *
 * Detects Python applications and their frameworks by analyzing
 * requirements.txt, pyproject.toml, and common entry points.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, AppType, SuggestedConfig } from '../detector.types';

// Framework indicators in requirements
const FRAMEWORK_PATTERNS: Record<string, { type: AppType; framework: string; confidence: number }> = {
  'django': { type: 'django', framework: 'django', confidence: 0.85 },
  'flask': { type: 'flask', framework: 'flask', confidence: 0.85 },
  'fastapi': { type: 'fastapi', framework: 'fastapi', confidence: 0.85 },
  'uvicorn': { type: 'fastapi', framework: 'fastapi', confidence: 0.70 },
  'gunicorn': { type: 'python', framework: 'wsgi', confidence: 0.60 },
  'celery': { type: 'python', framework: 'celery', confidence: 0.50 },
};

// Entry point files
const ENTRY_POINT_FILES = [
  'app.py',
  'main.py',
  'wsgi.py',
  'asgi.py',
  'manage.py',
  'server.py',
  'run.py',
];

export const pythonDetector: AppDetector = {
  name: 'python',
  priority: 70,

  async detect(appPath: string): Promise<DetectionResult | null> {
    // Check for Python indicators
    const hasRequirements = await fileExists(path.join(appPath, 'requirements.txt'));
    const hasPyproject = await fileExists(path.join(appPath, 'pyproject.toml'));
    const hasSetupPy = await fileExists(path.join(appPath, 'setup.py'));
    const hasPipfile = await fileExists(path.join(appPath, 'Pipfile'));

    if (!hasRequirements && !hasPyproject && !hasSetupPy && !hasPipfile) {
      return null;
    }

    const warnings: string[] = [];
    let type: AppType = 'python';
    let framework: string | null = null;
    let confidence = 0.70;
    let detectedBy = 'python-project';

    // Check for Django (manage.py is a strong indicator)
    const hasManagePy = await fileExists(path.join(appPath, 'manage.py'));
    if (hasManagePy) {
      type = 'django';
      framework = 'django';
      confidence = 0.90;
      detectedBy = 'manage.py';
    }

    // Parse requirements.txt for framework detection
    if (hasRequirements && type === 'python') {
      const requirements = await readRequirements(path.join(appPath, 'requirements.txt'));

      for (const req of requirements) {
        const reqName = req.toLowerCase();
        for (const [pattern, info] of Object.entries(FRAMEWORK_PATTERNS)) {
          if (reqName.startsWith(pattern)) {
            if (info.confidence > confidence) {
              type = info.type;
              framework = info.framework;
              confidence = info.confidence;
              detectedBy = `requirement:${pattern}`;
            }
          }
        }
      }
    }

    // Find entry point
    const entryPoint = await findEntryPoint(appPath);

    // Generate suggested config
    const suggestedConfig = generatePythonConfig(type, framework, entryPoint, hasRequirements, hasPipfile);

    // Check for common issues
    if (!entryPoint && type !== 'django') {
      warnings.push('No entry point file found (app.py, main.py, etc.)');
    }

    if (hasRequirements && hasPipfile) {
      warnings.push('Both requirements.txt and Pipfile found - consider using only one');
    }

    return {
      type,
      framework,
      confidence,
      detectedBy,
      suggestedConfig,
      warnings,
      metadata: {
        hasRequirements,
        hasPyproject,
        hasPipfile,
        hasManagePy,
        entryPoint,
      },
    };
  },
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRequirements(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && !line.startsWith('-'))
      .map(line => line.split(/[=<>!~[]/)[0].trim());
  } catch {
    return [];
  }
}

async function findEntryPoint(appPath: string): Promise<string | null> {
  for (const file of ENTRY_POINT_FILES) {
    if (await fileExists(path.join(appPath, file))) {
      return file;
    }
  }
  return null;
}

function generatePythonConfig(
  type: AppType,
  _framework: string | null,
  entryPoint: string | null,
  hasRequirements: boolean,
  hasPipfile: boolean
): SuggestedConfig {
  const config: SuggestedConfig = {};

  // Install command
  if (hasPipfile) {
    config.installCommand = 'pipenv install';
  } else if (hasRequirements) {
    config.installCommand = 'pip install -r requirements.txt';
  }

  // Start command based on framework
  switch (type) {
    case 'django':
      config.startCommand = 'gunicorn --bind 0.0.0.0:$PORT wsgi:application';
      config.port = 8000;
      break;

    case 'flask':
      if (entryPoint) {
        const module = entryPoint.replace('.py', '');
        config.startCommand = `gunicorn --bind 0.0.0.0:$PORT ${module}:app`;
      } else {
        config.startCommand = 'gunicorn --bind 0.0.0.0:$PORT app:app';
      }
      config.port = 5000;
      break;

    case 'fastapi':
      if (entryPoint) {
        const module = entryPoint.replace('.py', '');
        config.startCommand = `uvicorn ${module}:app --host 0.0.0.0 --port $PORT`;
      } else {
        config.startCommand = 'uvicorn main:app --host 0.0.0.0 --port $PORT';
      }
      config.port = 8000;
      break;

    default:
      if (entryPoint) {
        config.startCommand = `python ${entryPoint}`;
      } else {
        config.startCommand = 'python app.py';
      }
      config.port = 8000;
  }

  config.env = {
    PYTHONUNBUFFERED: '1',
  };

  return config;
}
