/**
 * Path Parser Tests
 *
 * The parser turns a watched directory name into an app name and, when the
 * folder is named like a hostname (optionally with a _port suffix), a route.
 * These are the rules that decide what gets deployed and where it's served.
 */

import * as path from 'path';
import {
  parsePath,
  isValidAppName,
  isValidHostname,
  extractAppName,
  getAppDirectory,
  isConfigFile,
} from './path-parser';

const BASE = path.join('/var', 'drop', 'webapps');
const p = (...segs: string[]): string => path.join(BASE, ...segs);

describe('parsePath', () => {
  it('treats a plain folder as an app name with no hostname', () => {
    expect(parsePath(p('myapp'), BASE)).toMatchObject({
      appName: 'myapp',
      hostname: null,
      port: null,
    });
  });

  it('reads a hostname-shaped folder as a routed hostname', () => {
    expect(parsePath(p('api.example.com'), BASE)).toMatchObject({
      appName: 'api.example.com',
      hostname: 'api.example.com',
      port: null,
    });
  });

  it('extracts hostname and port from a host_port folder', () => {
    expect(parsePath(p('staging.example.com_8080'), BASE)).toMatchObject({
      appName: 'staging.example.com_8080',
      hostname: 'staging.example.com',
      port: 8080,
    });
  });

  it('does not extract a port when the left side is not a valid hostname', () => {
    // 'myapp' has no dot, so it is not a hostname → the whole name is the app.
    expect(parsePath(p('myapp_8080'), BASE)).toMatchObject({
      appName: 'myapp_8080',
      hostname: null,
      port: null,
    });
  });

  it('ignores an out-of-range port suffix', () => {
    expect(parsePath(p('staging.example.com_99999'), BASE)).toMatchObject({
      hostname: null,
      port: null,
    });
  });

  it('uses only the first path segment (the app dir), ignoring nested files', () => {
    expect(parsePath(p('myapp', 'src', 'index.js'), BASE)).toMatchObject({
      appName: 'myapp',
      hostname: null,
    });
  });

  it('rejects non-app first segments (node_modules, hidden dirs)', () => {
    expect(parsePath(p('node_modules'), BASE).appName).toBe('');
    expect(parsePath(p('.git'), BASE).appName).toBe('');
  });

  it('returns an empty result when the path is the base dir itself', () => {
    expect(parsePath(BASE, BASE)).toMatchObject({ appName: '', hostname: null, port: null });
  });
});

describe('isValidAppName', () => {
  it('accepts ordinary names', () => {
    expect(isValidAppName('myapp')).toBe(true);
    expect(isValidAppName('api.example.com')).toBe(true);
  });

  it('rejects empty, dot refs, hidden, and known non-app dirs', () => {
    for (const bad of ['', '.', '..', '.hidden', 'node_modules', '__pycache__', '.git']) {
      expect(isValidAppName(bad)).toBe(false);
    }
  });

  it('is case-insensitive for the reserved directory names', () => {
    expect(isValidAppName('Node_Modules')).toBe(false);
  });
});

describe('isValidHostname', () => {
  it('accepts multi-label DNS names', () => {
    expect(isValidHostname('api.example.com')).toBe(true);
    expect(isValidHostname('a.b.co')).toBe(true);
  });

  it('rejects single-label names and underscores', () => {
    expect(isValidHostname('localhost')).toBe(false); // no dot → not multi-label
    expect(isValidHostname('has_underscore.com')).toBe(false);
  });

  it('rejects a label longer than 63 characters', () => {
    expect(isValidHostname(`${'a'.repeat(64)}.com`)).toBe(false);
  });
});

describe('extractAppName / getAppDirectory', () => {
  it('extractAppName returns the app name or null', () => {
    expect(extractAppName(p('myapp', 'index.js'), BASE)).toBe('myapp');
    expect(extractAppName(p('node_modules'), BASE)).toBeNull();
  });

  it('getAppDirectory returns the app dir path or null at base', () => {
    expect(getAppDirectory(p('myapp', 'src'), BASE)).toBe(p('myapp'));
    expect(getAppDirectory(BASE, BASE)).toBeNull();
  });
});

describe('isConfigFile', () => {
  it('recognises DROP and ecosystem config files by basename', () => {
    for (const f of ['drop.yaml', '.droprc.json', 'Procfile', 'package.json', 'go.mod']) {
      expect(isConfigFile(p('myapp', f))).toBe(true);
    }
  });

  it('does not treat ordinary source files as config', () => {
    expect(isConfigFile(p('myapp', 'index.js'))).toBe(false);
    expect(isConfigFile(p('myapp', 'README.md'))).toBe(false);
  });
});
