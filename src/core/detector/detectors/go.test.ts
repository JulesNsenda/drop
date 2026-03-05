import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { goDetector } from './go';

describe('Go Detector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-go-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should detect a Go app from go.mod', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      'module github.com/user/myapp\n\ngo 1.21\n'
    );
    await fs.writeFile(path.join(tmpDir, 'main.go'), 'package main');

    const result = await goDetector.detect(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('go');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.80);
    expect(result!.metadata.module).toBe('github.com/user/myapp');
    expect(result!.metadata.goVersion).toBe('1.21');
  });

  it('should detect Gin framework', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      [
        'module github.com/user/api',
        '',
        'go 1.22',
        '',
        'require (',
        '\tgithub.com/gin-gonic/gin v1.9.1',
        ')',
      ].join('\n')
    );
    await fs.writeFile(path.join(tmpDir, 'main.go'), 'package main');

    const result = await goDetector.detect(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('gin');
    expect(result!.confidence).toBe(0.90);
  });

  it('should detect Fiber framework', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      [
        'module myapp',
        'go 1.22',
        'require github.com/gofiber/fiber v2.52.0',
      ].join('\n')
    );
    await fs.writeFile(path.join(tmpDir, 'main.go'), 'package main');

    const result = await goDetector.detect(tmpDir);
    expect(result!.framework).toBe('fiber');
  });

  it('should return null for non-Go apps', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    const result = await goDetector.detect(tmpDir);
    expect(result).toBeNull();
  });

  it('should warn when no main.go or cmd/ found', async () => {
    await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module mylib\ngo 1.21\n');
    const result = await goDetector.detect(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.warnings).toContain('No main.go or cmd/ directory found');
  });

  it('should suggest correct build and start commands', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      'module github.com/user/myapp\ngo 1.21\n'
    );
    await fs.writeFile(path.join(tmpDir, 'main.go'), 'package main');

    const result = await goDetector.detect(tmpDir);
    expect(result!.suggestedConfig.buildCommand).toContain('go build');
    expect(result!.suggestedConfig.buildCommand).toContain('myapp');
    expect(result!.suggestedConfig.startCommand).toContain('myapp');
    expect(result!.suggestedConfig.port).toBe(8080);
  });

  it('should handle cmd/ directory pattern', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'go.mod'),
      'module github.com/user/server\ngo 1.21\n'
    );
    await fs.mkdir(path.join(tmpDir, 'cmd'), { recursive: true });

    const result = await goDetector.detect(tmpDir);
    expect(result!.suggestedConfig.buildCommand).toContain('./cmd/');
  });
});
