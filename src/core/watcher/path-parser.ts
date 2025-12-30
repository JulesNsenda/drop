/**
 * Path Parser
 *
 * Parses directory names to extract hostname, port, and app name information.
 * Supports hostname patterns like:
 * - api.example.com/ -> hostname: api.example.com
 * - staging.example.com_8080 -> hostname: staging.example.com, port: 8080
 * - myapp/ -> appName: myapp (no hostname)
 */

import * as path from 'path';
import { ParsedPath } from './watcher.types';

// Hostname pattern: valid DNS hostname
const HOSTNAME_PATTERN = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// Hostname with port pattern: hostname_port
const HOSTNAME_PORT_PATTERN = /^(.+)_(\d+)$/;

// Valid port range
const MIN_PORT = 1;
const MAX_PORT = 65535;

export function parsePath(filePath: string, baseDir: string): ParsedPath {
  // Get relative path from base directory
  const relativePath = path.relative(baseDir, filePath);

  // Split into path segments
  const segments = relativePath.split(path.sep).filter(s => s.length > 0);

  if (segments.length === 0) {
    return {
      appName: '',
      hostname: null,
      port: null,
      relativePath: '',
    };
  }

  // First segment is the app/hostname directory
  const firstSegment = segments[0];

  // Try to parse as hostname_port pattern
  const portMatch = firstSegment.match(HOSTNAME_PORT_PATTERN);
  if (portMatch) {
    const [, potentialHostname, portStr] = portMatch;
    const port = parseInt(portStr, 10);

    if (port >= MIN_PORT && port <= MAX_PORT) {
      // Check if the first part is a valid hostname
      if (isValidHostname(potentialHostname)) {
        return {
          appName: firstSegment,
          hostname: potentialHostname,
          port,
          relativePath,
        };
      }
    }
  }

  // Try to parse as hostname (no port)
  if (isValidHostname(firstSegment)) {
    return {
      appName: firstSegment,
      hostname: firstSegment,
      port: null,
      relativePath,
    };
  }

  // Just an app name, no hostname pattern detected
  return {
    appName: firstSegment,
    hostname: null,
    port: null,
    relativePath,
  };
}

export function isValidHostname(hostname: string): boolean {
  // Must match DNS hostname pattern
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return false;
  }

  // Additional checks
  if (hostname.length > 253) {
    return false;
  }

  // Each label must be 63 characters or less
  const labels = hostname.split('.');
  for (const label of labels) {
    if (label.length > 63) {
      return false;
    }
  }

  return true;
}

export function extractAppName(filePath: string, baseDir: string): string | null {
  const parsed = parsePath(filePath, baseDir);
  return parsed.appName || null;
}

export function getAppDirectory(filePath: string, baseDir: string): string | null {
  const relativePath = path.relative(baseDir, filePath);
  const segments = relativePath.split(path.sep).filter(s => s.length > 0);

  if (segments.length === 0) {
    return null;
  }

  return path.join(baseDir, segments[0]);
}

export function isConfigFile(filePath: string): boolean {
  const basename = path.basename(filePath);

  // Common configuration file patterns
  const configPatterns = [
    'drop.yaml',
    'drop.yml',
    'drop.json',
    'drop.config.js',
    'drop.config.ts',
    '.droprc',
    '.droprc.json',
    '.droprc.yaml',
    '.droprc.yml',
    'Procfile',
    'package.json',
    'requirements.txt',
    'Gemfile',
    'go.mod',
    'Cargo.toml',
    'composer.json',
  ];

  return configPatterns.includes(basename);
}
