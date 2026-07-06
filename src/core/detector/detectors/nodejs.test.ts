/**
 * Node.js Detector Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { nodejsDetector } from './nodejs';

describe('nodejsDetector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null when there is no package.json', async () => {
    const result = await nodejsDetector.detect(tmpDir);

    expect(result).toBeNull();
  });

  it('detects a plain Node.js app from package.json with a start script', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'plain-app', scripts: { start: 'node server.js' } })
    );

    const result = await nodejsDetector.detect(tmpDir);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('nodejs');
    expect(result?.framework).toBeNull();
    expect(result?.confidence).toBe(0.7);
    expect(result?.detectedBy).toBe('package.json');
    expect(result?.suggestedConfig.startCommand).toBe('node server.js');
    // start script present -> no start warning; plain nodejs never needs a build script
    expect(result?.warnings).not.toContainEqual(expect.stringContaining('No "start" script'));
    expect(result?.warnings).not.toContainEqual(expect.stringContaining('No "build" script'));
    expect(result?.warnings).toContainEqual(
      expect.stringContaining('No Node.js version specified')
    );
  });

  it('detects Express from dependencies with the documented confidence', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'express-app',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      })
    );

    const result = await nodejsDetector.detect(tmpDir);

    expect(result?.type).toBe('express');
    expect(result?.framework).toBe('express');
    expect(result?.confidence).toBe(0.75);
    expect(result?.detectedBy).toBe('dependency:express');
  });

  it('prefers a framework config file over a dependency match', async () => {
    // Both next.config.js AND an express dependency are present. The config-file
    // scan runs first and `break`s on the first match, so the dependency loop
    // (which would otherwise pick express) never runs.
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'both', dependencies: { express: '^4.18.0' } })
    );
    await fs.writeFile(path.join(tmpDir, 'next.config.js'), 'module.exports = {}');

    const result = await nodejsDetector.detect(tmpDir);

    expect(result?.type).toBe('nextjs');
    expect(result?.framework).toBe('next');
    expect(result?.confidence).toBe(0.95);
    expect(result?.detectedBy).toBe('config:next.config.js');
    expect(result?.suggestedConfig.outputDirectory).toBe('.next');
    expect(result?.suggestedConfig.port).toBe(3000);
  });

  it('falls back to package.json "main" for the start command when no start script exists', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'main-app', main: 'lib/entry.js' })
    );

    const result = await nodejsDetector.detect(tmpDir);

    expect(result?.suggestedConfig.startCommand).toBe('node lib/entry.js');
    expect(result?.warnings).toContainEqual(expect.stringContaining('No "start" script'));
  });

  it('warns about a missing build script for frameworks that require a build step', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'astro-app', scripts: { start: 'node ./dist/server/entry.mjs' } })
    );
    await fs.writeFile(path.join(tmpDir, 'astro.config.mjs'), '');

    const result = await nodejsDetector.detect(tmpDir);

    expect(result?.type).toBe('astro');
    expect(result?.suggestedConfig.port).toBe(4321);
    expect(result?.suggestedConfig.outputDirectory).toBe('dist');
    expect(result?.warnings).toContainEqual(expect.stringContaining('No "build" script'));
  });

  it('records engines.node and suppresses the node-version warning when present', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'versioned',
        scripts: { start: 'node index.js' },
        engines: { node: '>=18.0.0' },
      })
    );

    const result = await nodejsDetector.detect(tmpDir);

    expect(result?.suggestedConfig.nodeVersion).toBe('>=18.0.0');
    expect(result?.warnings).not.toContainEqual(
      expect.stringContaining('No Node.js version specified')
    );
  });
});
