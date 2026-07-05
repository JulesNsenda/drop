/**
 * Detector Service Tests
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock event bus before importing detector
jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

import { DetectorService } from './detector';
import { manifestDetector, validateManifest } from './detectors/manifest';
import { nodejsDetector } from './detectors/nodejs';
import { pythonDetector } from './detectors/python';
import { staticDetector } from './detectors/static';
import { dockerDetector } from './detectors/docker';
import { AppType } from './detector.types';

describe('DetectorService', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-detector-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const service = new DetectorService();
      const config = service.getConfig();

      expect(config.confidenceThreshold).toBe(0.5);
      expect(config.enableManifestDetection).toBe(true);
    });

    it('should register built-in detectors', () => {
      const service = new DetectorService();
      const detectors = service.getDetectors();

      expect(detectors.length).toBeGreaterThanOrEqual(5);
      expect(detectors.some(d => d.name === 'manifest')).toBe(true);
      expect(detectors.some(d => d.name === 'nodejs')).toBe(true);
    });

    it('should allow disabling manifest detection', () => {
      const service = new DetectorService({ enableManifestDetection: false });
      const detectors = service.getDetectors();

      expect(detectors.some(d => d.name === 'manifest')).toBe(false);
    });
  });

  describe('registerDetector', () => {
    it('should add custom detector', () => {
      const service = new DetectorService();
      const customDetector = {
        name: 'custom',
        priority: 50,
        detect: jest.fn().mockResolvedValue(null),
      };

      service.registerDetector(customDetector);

      expect(service.getDetectors().some(d => d.name === 'custom')).toBe(true);
    });

    it('should replace detector with same name', () => {
      const service = new DetectorService();
      const detector1 = { name: 'test', priority: 50, detect: jest.fn() };
      const detector2 = { name: 'test', priority: 100, detect: jest.fn() };

      service.registerDetector(detector1);
      service.registerDetector(detector2);

      const detectors = service.getDetectors().filter(d => d.name === 'test');
      expect(detectors.length).toBe(1);
      expect(detectors[0].priority).toBe(100);
    });
  });

  describe('detect', () => {
    it('should throw for non-existent path', async () => {
      const service = new DetectorService();

      await expect(service.detect('/non/existent/path'))
        .rejects.toThrow('Path does not exist');
    });

    it('should return unknown for empty directory', async () => {
      const emptyDir = path.join(tempDir, 'empty');
      await fs.mkdir(emptyDir, { recursive: true });

      const service = new DetectorService();
      const result = await service.detect(emptyDir);

      expect(result.type).toBe('unknown');
      expect(result.confidence).toBe(0);
    });

    describe('silent option (P1-6)', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { eventBus } = require('../event-bus');
      const detectedCount = (): number =>
        (eventBus.publish as jest.Mock).mock.calls.filter(
          (c: unknown[]) => c[0] === 'app:detected'
        ).length;

      it('publishes app:detected by default', async () => {
        (eventBus.publish as jest.Mock).mockClear();
        await new DetectorService().detect(tempDir);
        expect(detectedCount()).toBe(1);
      });

      it('does not publish app:detected when silent (internal re-detection)', async () => {
        (eventBus.publish as jest.Mock).mockClear();
        await new DetectorService().detect(tempDir, { silent: true });
        expect(detectedCount()).toBe(0);
      });
    });
  });
});

describe('Manifest Detector', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-manifest-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should detect drop.yaml', async () => {
    const appDir = path.join(tempDir, 'yaml-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'drop.yaml'),
      'type: nodejs\nframework: express\nport: 3000'
    );

    const result = await manifestDetector.detect(appDir);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('nodejs');
    expect(result?.framework).toBe('express');
    expect(result?.confidence).toBe(1.0);
  });

  it('should detect drop.json', async () => {
    const appDir = path.join(tempDir, 'json-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'drop.json'),
      JSON.stringify({ type: 'python', framework: 'fastapi' })
    );

    const result = await manifestDetector.detect(appDir);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('python');
    expect(result?.framework).toBe('fastapi');
    expect(result?.confidence).toBe(1.0);
  });

  it('should return null when no manifest', async () => {
    const appDir = path.join(tempDir, 'no-manifest');
    await fs.mkdir(appDir, { recursive: true });

    const result = await manifestDetector.detect(appDir);

    expect(result).toBeNull();
  });

  it('should warn about missing type', async () => {
    const appDir = path.join(tempDir, 'missing-type');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'drop.yaml'),
      'framework: express'
    );

    const result = await manifestDetector.detect(appDir);

    expect(result?.type).toBe('unknown');
    expect(result?.warnings).toContainEqual(expect.stringContaining('missing "type"'));
  });
});

describe('validateManifest', () => {
  it('should validate valid manifest', () => {
    const errors = validateManifest({ type: 'nodejs', port: 3000 });
    expect(errors).toHaveLength(0);
  });

  it('should reject invalid type', () => {
    const errors = validateManifest({ type: 'invalid' as AppType });
    expect(errors).toContainEqual(expect.stringContaining('Invalid app type'));
  });

  it('should reject invalid port', () => {
    const errors = validateManifest({ port: 99999 });
    expect(errors).toContainEqual(expect.stringContaining('Invalid port'));
  });
});

describe('Node.js Detector', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should detect basic Node.js app', async () => {
    const appDir = path.join(tempDir, 'node-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        scripts: { start: 'node index.js' },
      })
    );

    const result = await nodejsDetector.detect(appDir);

    expect(result).not.toBeNull();
    expect(result?.type).toBe('nodejs');
  });

  it('should detect Next.js from config file', async () => {
    const appDir = path.join(tempDir, 'nextjs-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'next-app' })
    );
    await fs.writeFile(path.join(appDir, 'next.config.js'), 'module.exports = {}');

    const result = await nodejsDetector.detect(appDir);

    expect(result?.type).toBe('nextjs');
    expect(result?.framework).toBe('next');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('should detect Express from dependencies', async () => {
    const appDir = path.join(tempDir, 'express-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'express-app',
        dependencies: { express: '^4.18.0' },
      })
    );

    const result = await nodejsDetector.detect(appDir);

    expect(result?.type).toBe('express');
    expect(result?.framework).toBe('express');
  });

  it('should return null for non-Node.js app', async () => {
    const appDir = path.join(tempDir, 'non-node');
    await fs.mkdir(appDir, { recursive: true });

    const result = await nodejsDetector.detect(appDir);

    expect(result).toBeNull();
  });

  it('should warn about missing start script', async () => {
    const appDir = path.join(tempDir, 'no-start');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'no-start-app' })
    );

    const result = await nodejsDetector.detect(appDir);

    expect(result?.warnings).toContainEqual(expect.stringContaining('No "start" script'));
  });
});

describe('Python Detector', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-python-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should detect Django from manage.py', async () => {
    const appDir = path.join(tempDir, 'django-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'manage.py'), '');
    await fs.writeFile(path.join(appDir, 'requirements.txt'), 'django==4.0');

    const result = await pythonDetector.detect(appDir);

    expect(result?.type).toBe('django');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('should detect Flask from requirements', async () => {
    const appDir = path.join(tempDir, 'flask-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'requirements.txt'), 'flask==2.0\nflask-cors');
    await fs.writeFile(path.join(appDir, 'app.py'), '');

    const result = await pythonDetector.detect(appDir);

    expect(result?.type).toBe('flask');
    expect(result?.framework).toBe('flask');
  });

  it('should detect FastAPI from requirements', async () => {
    const appDir = path.join(tempDir, 'fastapi-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'requirements.txt'), 'fastapi\nuvicorn');
    await fs.writeFile(path.join(appDir, 'main.py'), '');

    const result = await pythonDetector.detect(appDir);

    expect(result?.type).toBe('fastapi');
  });

  it('should return null for non-Python app', async () => {
    const appDir = path.join(tempDir, 'non-python');
    await fs.mkdir(appDir, { recursive: true });

    const result = await pythonDetector.detect(appDir);

    expect(result).toBeNull();
  });
});

describe('Static Detector', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should detect static site with index.html', async () => {
    const appDir = path.join(tempDir, 'static-site');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'index.html'), '<html></html>');

    const result = await staticDetector.detect(appDir);

    expect(result?.type).toBe('static');
  });

  it('should detect SPA indicators', async () => {
    const appDir = path.join(tempDir, 'spa-site');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'index.html'),
      '<html><div id="root"></div></html>'
    );

    const result = await staticDetector.detect(appDir);

    expect(result?.type).toBe('spa');
  });

  it('should detect build output directory', async () => {
    const appDir = path.join(tempDir, 'built-site');
    const distDir = path.join(appDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, 'index.html'), '<html></html>');

    const result = await staticDetector.detect(appDir);

    expect(result?.type).toBe('static');
    expect(result?.metadata?.buildDir).toBe('dist');
  });

  it('should return null for non-static app', async () => {
    const appDir = path.join(tempDir, 'non-static');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'readme.md'), '# README');

    const result = await staticDetector.detect(appDir);

    expect(result).toBeNull();
  });
});

describe('Docker Detector', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should detect Dockerfile', async () => {
    const appDir = path.join(tempDir, 'docker-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'Dockerfile'),
      'FROM node:18\nEXPOSE 3000\nCMD ["node", "index.js"]'
    );

    const result = await dockerDetector.detect(appDir);

    expect(result?.type).toBe('docker');
    expect(result?.metadata?.exposedPort).toBe(3000);
    expect(result?.metadata?.baseImage).toBe('node:18');
  });

  it('should detect docker-compose', async () => {
    const appDir = path.join(tempDir, 'compose-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'docker-compose.yml'), 'version: "3"');

    const result = await dockerDetector.detect(appDir);

    expect(result?.type).toBe('docker');
    expect(result?.framework).toBe('docker-compose');
  });

  it('should warn about missing EXPOSE', async () => {
    const appDir = path.join(tempDir, 'no-expose');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'Dockerfile'),
      'FROM node:18\nCMD ["node", "index.js"]'
    );

    const result = await dockerDetector.detect(appDir);

    expect(result?.warnings).toContainEqual(expect.stringContaining('No EXPOSE'));
  });

  it('should return null for non-Docker app', async () => {
    const appDir = path.join(tempDir, 'non-docker');
    await fs.mkdir(appDir, { recursive: true });

    const result = await dockerDetector.detect(appDir);

    expect(result).toBeNull();
  });
});
