/**
 * Manifest Detector Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { manifestDetector, validateManifest } from './manifest';
import { AppType } from '../detector.types';

describe('manifestDetector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null when no manifest file exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');

    const result = await manifestDetector.detect(tmpDir);

    expect(result).toBeNull();
  });

  it('reads a full drop.yaml manifest and maps every field into suggestedConfig', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'drop.yaml'),
      [
        'type: nodejs',
        'framework: express',
        'build:',
        '  command: npm run build',
        '  output: dist',
        'start:',
        '  command: npm start',
        'install:',
        '  command: npm ci',
        'port: 4000',
        'env:',
        '  NODE_ENV: production',
        'database: postgres',
      ].join('\n')
    );

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('nodejs');
    expect(result?.framework).toBe('express');
    expect(result?.confidence).toBe(1.0);
    expect(result?.detectedBy).toBe('manifest:drop.yaml');
    expect(result?.suggestedConfig).toEqual({
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      installCommand: 'npm ci',
      outputDirectory: 'dist',
      port: 4000,
      env: { NODE_ENV: 'production' },
      database: 'postgres',
    });
    expect(result?.warnings).toHaveLength(0);
    expect(result?.metadata.manifestFile).toBe('drop.yaml');
  });

  it('prefers drop.yaml over drop.json when both are present', async () => {
    await fs.writeFile(path.join(tmpDir, 'drop.yaml'), 'type: nodejs');
    await fs.writeFile(path.join(tmpDir, 'drop.json'), JSON.stringify({ type: 'python' }));

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('nodejs');
    expect(result?.detectedBy).toBe('manifest:drop.yaml');
  });

  it('parses a .droprc file (no extension) as JSON via the fallback parser', async () => {
    await fs.writeFile(path.join(tmpDir, '.droprc'), JSON.stringify({ type: 'go' }));

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('go');
    expect(result?.detectedBy).toBe('manifest:.droprc');
  });

  it('parses a .droprc.yaml file as YAML', async () => {
    await fs.writeFile(path.join(tmpDir, '.droprc.yaml'), 'type: rust\n');

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('rust');
    expect(result?.detectedBy).toBe('manifest:.droprc.yaml');
  });

  it('warns and defaults to "unknown" when the manifest has no "type" field', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'drop.yaml'),
      'framework: express\nstart:\n  command: npm start'
    );

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('unknown');
    expect(result?.warnings).toContainEqual(expect.stringContaining('missing "type"'));
    // start.command is present, so the separate start/build warning must not fire
    expect(result?.warnings).not.toContainEqual(
      expect.stringContaining('missing both start and build')
    );
  });

  it('warns when both start and build commands are missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'drop.yaml'), 'type: docker');

    const result = await manifestDetector.detect(tmpDir);

    expect(result?.type).toBe('docker');
    expect(result?.warnings).toContainEqual(
      expect.stringContaining('missing both start and build commands')
    );
  });

  it('gracefully returns null when the only manifest file present fails to parse', async () => {
    // Unterminated flow sequence - guaranteed YAMLParseError, caught internally by
    // readManifest() so detect() just moves on (and ultimately finds nothing).
    await fs.writeFile(path.join(tmpDir, 'drop.yaml'), 'foo: [1, 2, 3');

    const result = await manifestDetector.detect(tmpDir);

    expect(result).toBeNull();
  });
});

describe('validateManifest', () => {
  it('returns no errors for a valid manifest', () => {
    const errors = validateManifest({ type: 'nodejs', port: 3000 });

    expect(errors).toHaveLength(0);
  });

  it('reports an invalid type and an invalid port together', () => {
    const errors = validateManifest({ type: 'not-a-real-type' as AppType, port: 70000 });

    expect(errors).toContainEqual(expect.stringContaining('Invalid app type'));
    expect(errors).toContainEqual(expect.stringContaining('Invalid port'));
  });
});
