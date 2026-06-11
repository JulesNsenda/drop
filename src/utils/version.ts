/**
 * Resolve the platform version from package.json.
 *
 * process.env.npm_package_version is only set when launched via an npm script,
 * not under PM2 or `node dist/...`, so we read package.json directly. Works
 * from both src/ (ts-node) and dist/ builds — package.json sits three levels
 * up from src/utils and dist/utils alike.
 */

import * as fs from 'fs';
import * as path from 'path';

let cached: string | null = null;

export function getPlatformVersion(): string {
  if (cached) return cached;
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const version = (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }).version;
    cached = version || process.env.npm_package_version || '0.0.0';
  } catch {
    cached = process.env.npm_package_version || '0.0.0';
  }
  return cached;
}
