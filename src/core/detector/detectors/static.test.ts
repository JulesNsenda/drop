/**
 * Static Site Detector Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { staticDetector } from './static';

describe('staticDetector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null when there is no index.html anywhere', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '# not a static site');

    const result = await staticDetector.detect(tmpDir);

    expect(result).toBeNull();
  });

  it('detects a plain static site from a root index.html', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<html><body>hi</body></html>');

    const result = await staticDetector.detect(tmpDir);

    expect(result?.type).toBe('static');
    expect(result?.framework).toBe('vanilla');
    expect(result?.confidence).toBe(0.6);
    expect(result?.detectedBy).toBe('root-index.html');
    expect(result?.metadata.servePath).toBe('.');
  });

  it('detects a build output directory and serves from it', async () => {
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');

    const result = await staticDetector.detect(tmpDir);

    expect(result?.type).toBe('static');
    expect(result?.confidence).toBe(0.7);
    expect(result?.detectedBy).toBe('build-dir:dist');
    expect(result?.metadata.buildDir).toBe('dist');
    expect(result?.metadata.servePath).toBe('dist');
    expect(result?.suggestedConfig.outputDirectory).toBe('dist');
  });

  it('picks the first matching build directory when several exist ("dist" before "public")', async () => {
    await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
    await fs.mkdir(path.join(tmpDir, 'public'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'public', 'index.html'), '<html></html>');

    const result = await staticDetector.detect(tmpDir);

    expect(result?.metadata.buildDir).toBe('dist');
  });

  it('detects an SPA from an explicit indicator file (manifest.json)', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<html><body>hi</body></html>');
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), '{}');

    const result = await staticDetector.detect(tmpDir);

    expect(result?.type).toBe('spa');
    expect(result?.framework).toBe('spa');
    // base root confidence (0.60) + 0.10 SPA bonus
    expect(result?.confidence).toBeCloseTo(0.7);
    expect(result?.detectedBy).toBe('root-index.html+spa-indicators');
    expect(result?.suggestedConfig.env).toEqual({ SPA_FALLBACK: 'true' });
  });

  it('detects an SPA from framework markup inside index.html', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'index.html'),
      '<html><body><div id="root"></div></body></html>'
    );

    const result = await staticDetector.detect(tmpDir);

    expect(result?.type).toBe('spa');
  });

  it('warns when package.json is present but the app is served from the (unbuilt) root', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"app"}');

    const result = await staticDetector.detect(tmpDir);

    expect(result?.warnings).toContainEqual(
      expect.stringContaining('may need to build first')
    );
  });

  it('warns about a large number of files when serving more than 1000 files', async () => {
    await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 1005; i++) {
      writes.push(fs.writeFile(path.join(tmpDir, `asset-${i}.txt`), ''));
    }
    await Promise.all(writes);

    const result = await staticDetector.detect(tmpDir);

    expect(result?.metadata.fileCount).toBeGreaterThan(1000);
    expect(result?.warnings).toContainEqual(
      expect.stringContaining('Large number of files')
    );
  }, 20000);
});
