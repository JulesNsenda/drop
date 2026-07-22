/**
 * Python Detector
 *
 * Detects Python applications and their frameworks by analyzing
 * requirements.txt, pyproject.toml, and common entry points.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, AppType, SuggestedConfig } from '../detector.types';
import { readProcfile, getWebCommand, ProcfileProcesses } from '../procfile';

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
    const hasManifest = hasRequirements || hasPyproject || hasSetupPy || hasPipfile;

    // Find entry point up front - it doubles as the detection signal below
    // when there is no dependency manifest.
    const entryPoint = await findEntryPoint(appPath);

    // No requirements.txt/pyproject.toml/setup.py/Pipfile: an app with just
    // an entry point file (app.py, main.py, ...) is still a real Python app,
    // so don't fall through to `unknown` - detect it at a lower confidence
    // instead. A Procfile reinforces the match (and its `web:` command, if
    // present, is a better start-command guess than the generic framework
    // default), but a Procfile alone - with no entry point - is NOT a Python
    // signal; plenty of other languages declare one too.
    let procfile: ProcfileProcesses | null = null;
    if (!hasManifest) {
      if (!entryPoint) {
        return null;
      }
      procfile = await readProcfile(appPath);
    }

    const warnings: string[] = [];
    let type: AppType = 'python';
    let framework: string | null = null;
    let confidence: number;
    let detectedBy: string;
    if (hasManifest) {
      confidence = 0.70;
      detectedBy = 'python-project';
    } else {
      confidence = 0.5;
      detectedBy = procfile ? 'entrypoint+procfile' : 'entrypoint';
    }

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
      const requirements = await readRequirements(appPath, 'requirements.txt');

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

    // Generate suggested config
    const suggestedConfig = generatePythonConfig(type, framework, entryPoint);

    // A Procfile `web:` command is the authoritative user-provided start
    // command for a manifest-less app - prefer it over the guessed default.
    const procfileWebCommand = getWebCommand(procfile);
    if (procfileWebCommand) {
      suggestedConfig.startCommand = procfileWebCommand;
    }

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

// Matches `-r <file>` / `--requirement <file>` / `-c <file>` / `--constraint <file>`
// include directives inside a requirements file.
const INCLUDE_DIRECTIVE = /^(?:-r|--requirement|-c|--constraint)\s+(.+)$/;

/**
 * Read `relativeFilePath` (relative to `appPath`) and return the dependency
 * names it declares, following any `-r`/`--requirement`/`-c`/`--constraint`
 * includes recursively. Includes are resolved relative to the directory of
 * the file that references them, guarded against cycles (visited-set) and
 * against escaping the app directory (never read outside `appPath`).
 */
async function readRequirements(appPath: string, relativeFilePath: string): Promise<string[]> {
  return readRequirementsFile(appPath, relativeFilePath, new Set<string>());
}

async function readRequirementsFile(
  appPath: string,
  relativeFilePath: string,
  visited: Set<string>
): Promise<string[]> {
  const absAppPath = path.resolve(appPath);
  const absFilePath = path.resolve(appPath, relativeFilePath);
  const relToApp = path.relative(absAppPath, absFilePath);

  // Containment guard: refuse anything that resolves outside the app dir.
  if (relToApp.startsWith('..') || path.isAbsolute(relToApp)) {
    return [];
  }

  // Cycle guard: canonicalize on the app-relative path so the same file
  // reached via different relative spellings is only ever read once.
  const visitKey = relToApp.split(path.sep).join('/');
  if (visited.has(visitKey)) {
    return [];
  }
  visited.add(visitKey);

  let content: string;
  try {
    content = await fs.readFile(absFilePath, 'utf-8');
  } catch {
    return [];
  }

  const currentDir = path.dirname(relativeFilePath);
  const results: string[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const includeMatch = INCLUDE_DIRECTIVE.exec(line);
    if (includeMatch) {
      const target = includeMatch[1].trim();
      if (path.isAbsolute(target)) continue; // reject absolute-path includes
      const targetRelative = path.join(currentDir, target);
      const included = await readRequirementsFile(appPath, targetRelative, visited);
      results.push(...included);
      continue;
    }

    if (line.startsWith('-')) continue; // other pip options (-e, --index-url, ...)

    results.push(line.split(/[=<>!~[]/)[0].trim());
  }

  return results;
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
  entryPoint: string | null
): SuggestedConfig {
  const config: SuggestedConfig = {};

  // Deliberately no installCommand. PythonBuildStrategy owns dependency
  // installation, and platform.buildApp passes whatever we suggest here
  // straight into BuildContext.config.installCommand — which the strategy
  // honors ahead of its own logic. Suggesting a command from here therefore
  // *replaces* the in-app-dir venv install rather than defaulting it, and a
  // bare `pip`/`pipenv` breaks both isolation modes: on a host build `pip` is
  // usually not on PATH at all ("/bin/sh: 1: pip: not found" — only `python3`
  // is guaranteed), and inside a build container it "succeeds" into
  // site-packages that are discarded with the container, leaving the runtime
  // with no deps ("No module named uvicorn"). Leaving it unset lets
  // PythonBuildStrategy.preBuild pick the correct `.venv`-based command.

  // Start command based on framework. Always invoke via `python -m` rather
  // than a bare `uvicorn`/`gunicorn` binary: at runtime `.venv/bin` is on
  // PATH so `python` is the venv interpreter and `-m <module>` resolves the
  // console-script iff it's installed - a bare binary name is not guaranteed
  // to be on PATH at all.
  switch (type) {
    case 'django':
      config.startCommand = 'python -m gunicorn --bind 0.0.0.0:$PORT wsgi:application';
      config.port = 8000;
      break;

    case 'flask':
      if (entryPoint) {
        const module = entryPoint.replace('.py', '');
        config.startCommand = `python -m gunicorn --bind 0.0.0.0:$PORT ${module}:app`;
      } else {
        config.startCommand = 'python -m gunicorn --bind 0.0.0.0:$PORT app:app';
      }
      config.port = 5000;
      break;

    case 'fastapi':
      if (entryPoint) {
        const module = entryPoint.replace('.py', '');
        config.startCommand = `python -m uvicorn ${module}:app --host 0.0.0.0 --port $PORT`;
      } else {
        config.startCommand = 'python -m uvicorn main:app --host 0.0.0.0 --port $PORT';
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
