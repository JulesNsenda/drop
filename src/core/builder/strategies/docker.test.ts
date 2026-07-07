/**
 * DockerBuildStrategy tests.
 *
 * Covers the pure command-generation methods (image-name sanitization) plus
 * the file-system-dependent preBuild Dockerfile/compose-file detection and
 * validate(). The strategy is a shared singleton, so it records the detected
 * file on the per-build BuildContext (config.dockerFile) rather than on the
 * instance — the "no leak across builds" test below locks that in.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DockerBuildStrategy } from './docker';
import { BuildContext } from '../builder.types';

describe('DockerBuildStrategy', () => {
  const ctx = (overrides: Partial<BuildContext> & { appName: string }): BuildContext =>
    ({
      appPath: '/tmp/app',
      appType: 'docker',
      framework: null,
      config: {},
      env: {},
      ...overrides,
    }) as unknown as BuildContext;

  describe('getInstallCommand', () => {
    it('is always null (no separate install step for Docker)', () => {
      const strategy = new DockerBuildStrategy();
      expect(strategy.getInstallCommand(ctx({ appName: 'app' }))).toBeNull();
    });
  });

  describe('getBuildCommand', () => {
    it('returns the custom buildCommand when configured', () => {
      const strategy = new DockerBuildStrategy();
      const c = ctx({ appName: 'app', config: { buildCommand: 'docker build -t custom .' } });
      expect(strategy.getBuildCommand(c)).toBe('docker build -t custom .');
    });

    it('derives "docker build -t <name>:latest ." from the (sanitized) app name', () => {
      const strategy = new DockerBuildStrategy();
      const c = ctx({ appName: 'My App' });
      expect(strategy.getBuildCommand(c)).toBe('docker build -t my-app:latest .');
    });

    it('sanitizes special characters out of the app name for the image tag', () => {
      const strategy = new DockerBuildStrategy();
      const c = ctx({ appName: 'App_1.0!/@Test' });
      const cmd = strategy.getBuildCommand(c)!;
      const imageName = cmd.match(/-t (\S+):latest/)![1];
      expect(imageName).toMatch(/^[a-z0-9-]+$/);
      expect(cmd).not.toContain('!');
      expect(cmd).not.toContain('/@');
    });
  });

  describe('getOutputDirectory', () => {
    it('is always null (Docker images are not stored in a directory)', () => {
      const strategy = new DockerBuildStrategy();
      expect(strategy.getOutputDirectory(ctx({ appName: 'app' }))).toBeNull();
    });
  });

  describe('preBuild', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('builds the default docker build command from a detected Dockerfile', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBe('docker build -t app:latest -f Dockerfile .');
    });

    it('prefers "Dockerfile" over "Containerfile" when both are present', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      await fs.writeFile(path.join(tmpDir, 'Containerfile'), 'FROM alpine\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toContain('-f Dockerfile');
    });

    it('falls back to "Containerfile" when no Dockerfile exists', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Containerfile'), 'FROM alpine\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBe('docker build -t app:latest -f Containerfile .');
    });

    it('prefers docker-compose over a Dockerfile when both are present', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      await fs.writeFile(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBe('docker-compose -f docker-compose.yml build');
    });

    it('prefers docker-compose.yml over compose.yaml', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"\n');
      await fs.writeFile(path.join(tmpDir, 'compose.yaml'), 'version: "3"\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBe('docker-compose -f docker-compose.yml build');
    });

    it('does not overwrite an explicit buildCommand', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      const c = ctx({ appName: 'app', appPath: tmpDir, config: { buildCommand: 'echo custom' } });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBe('echo custom');
    });

    it('leaves buildCommand unset when no Dockerfile/compose file is found', async () => {
      const strategy = new DockerBuildStrategy();
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBeUndefined();
    });

    it('does not leak a detected file into a later, unrelated build (shared singleton is stateless)', async () => {
      // The strategy is exported as one shared instance reused for every docker
      // app, so per-build detection must live on the context, not the instance.
      const strategy = new DockerBuildStrategy();

      const appA = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-a-'));
      const appB = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-b-'));
      try {
        await fs.writeFile(path.join(appA, 'Dockerfile'), 'FROM node:20\n');
        const ctxA = ctx({ appName: 'app-a', appPath: appA });
        await strategy.preBuild(ctxA);
        expect(ctxA.config.buildCommand).toBe('docker build -t app-a:latest -f Dockerfile .');

        // appB has no Docker files at all → it must NOT inherit appA's Dockerfile.
        const ctxB = ctx({ appName: 'app-b', appPath: appB });
        await strategy.preBuild(ctxB);
        expect(ctxB.config.buildCommand).toBeUndefined();
        expect(ctxB.config.dockerFile).toBeUndefined();
      } finally {
        await fs.rm(appA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await fs.rm(appB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  });

  describe('validate', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-validate-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('validates against the Dockerfile detected during preBuild', async () => {
      const strategy = new DockerBuildStrategy();
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      const c = ctx({ appName: 'app', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(await strategy.validate(c, '')).toBe(true);
    });

    it('falls back to checking for a default Dockerfile/docker-compose.yml when preBuild was not run', async () => {
      const strategy = new DockerBuildStrategy();
      const c = ctx({ appName: 'app', appPath: tmpDir });
      expect(await strategy.validate(c, '')).toBe(false);
      await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:20\n');
      expect(await strategy.validate(c, '')).toBe(true);
    });
  });
});
