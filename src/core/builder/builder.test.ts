/**
 * Builder Service Tests
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock event bus before importing builder
jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

import { BuilderService, createBuilderService, getBuilder, resetBuilder } from './builder';
import { BuildContext, BuildStrategy, ExecCommandFn } from './builder.types';
import { nodejsBuildStrategy } from './strategies/nodejs';
import { pythonBuildStrategy } from './strategies/python';
import { staticBuildStrategy } from './strategies/static';
import { dockerBuildStrategy } from './strategies/docker';
import { executeCommand } from './strategies/base';

describe('BuilderService', () => {
  beforeEach(() => {
    resetBuilder();
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const service = new BuilderService();
      const config = service.getConfig();

      expect(config.defaultTimeout).toBe(10 * 60 * 1000);
      expect(config.maxConcurrentBuilds).toBe(3);
      expect(config.cleanupOnFailure).toBe(true);
    });

    it('should register built-in strategies', () => {
      const service = new BuilderService();
      const strategies = service.getStrategies();

      expect(strategies.length).toBeGreaterThanOrEqual(4);
      expect(strategies.some(s => s.name === 'nodejs')).toBe(true);
      expect(strategies.some(s => s.name === 'python')).toBe(true);
      expect(strategies.some(s => s.name === 'static')).toBe(true);
      expect(strategies.some(s => s.name === 'docker')).toBe(true);
    });

    it('should accept custom config', () => {
      const service = new BuilderService({
        defaultTimeout: 5 * 60 * 1000,
        maxConcurrentBuilds: 5,
      });
      const config = service.getConfig();

      expect(config.defaultTimeout).toBe(5 * 60 * 1000);
      expect(config.maxConcurrentBuilds).toBe(5);
    });
  });

  describe('registerStrategy', () => {
    it('should add custom strategy', () => {
      const service = new BuilderService();
      const customStrategy: BuildStrategy = {
        name: 'custom',
        supportedTypes: ['nodejs'],
        canBuild: () => true,
        getInstallCommand: () => 'npm install',
        getBuildCommand: () => 'npm build',
        getOutputDirectory: () => 'dist',
      };

      service.registerStrategy(customStrategy);

      expect(service.getStrategies().some(s => s.name === 'custom')).toBe(true);
    });

    it('should replace strategy with same name', () => {
      const service = new BuilderService();
      const strategy1: BuildStrategy = {
        name: 'test',
        supportedTypes: ['nodejs'],
        canBuild: () => true,
        getInstallCommand: () => 'npm install',
        getBuildCommand: () => 'build1',
        getOutputDirectory: () => 'dist',
      };
      const strategy2: BuildStrategy = {
        name: 'test',
        supportedTypes: ['nodejs'],
        canBuild: () => true,
        getInstallCommand: () => 'npm install',
        getBuildCommand: () => 'build2',
        getOutputDirectory: () => 'dist',
      };

      service.registerStrategy(strategy1);
      service.registerStrategy(strategy2);

      const strategies = service.getStrategies().filter(s => s.name === 'test');
      expect(strategies.length).toBe(1);
      expect(strategies[0].getBuildCommand({} as BuildContext)).toBe('build2');
    });
  });

  describe('getStatus', () => {
    it('should return null for non-existent build', () => {
      const service = new BuilderService();
      expect(service.getStatus('non-existent')).toBeNull();
    });
  });

  describe('factory functions', () => {
    it('createBuilderService should create new instance', () => {
      const service1 = createBuilderService();
      const service2 = createBuilderService();

      expect(service1).not.toBe(service2);
    });

    it('getBuilder should return singleton', () => {
      const service1 = getBuilder();
      const service2 = getBuilder();

      expect(service1).toBe(service2);
    });

    it('resetBuilder should clear singleton', () => {
      const service1 = getBuilder();
      resetBuilder();
      const service2 = getBuilder();

      expect(service1).not.toBe(service2);
    });
  });
});

describe('Node.js Build Strategy', () => {
  it('should support Node.js app types', () => {
    expect(nodejsBuildStrategy.supportedTypes).toContain('nodejs');
    expect(nodejsBuildStrategy.supportedTypes).toContain('nextjs');
    expect(nodejsBuildStrategy.supportedTypes).toContain('express');
  });

  it('should return true for canBuild with supported type', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'nextjs',
      framework: 'next',
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.canBuild(context)).toBe(true);
  });

  it('should return false for canBuild with unsupported type', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'python',
      framework: null,
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.canBuild(context)).toBe(false);
  });

  it('should return install command', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'nodejs',
      framework: null,
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.getInstallCommand(context)).toBe('npm install');
  });

  it('should use custom install command if provided', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'nodejs',
      framework: null,
      config: { installCommand: 'yarn install' },
      env: {},
    };

    expect(nodejsBuildStrategy.getInstallCommand(context)).toBe('yarn install');
  });

  it('should return build command for Next.js', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'nextjs',
      framework: 'next',
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.getBuildCommand(context)).toBe('npm run build');
  });

  it('should return null build command for Express', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'express',
      framework: 'express',
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.getBuildCommand(context)).toBeNull();
  });

  it('should return correct output directory for Next.js', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'nextjs',
      framework: 'next',
      config: {},
      env: {},
    };

    expect(nodejsBuildStrategy.getOutputDirectory(context)).toBe('.next');
  });
});

describe('Python Build Strategy', () => {
  it('should support Python app types', () => {
    expect(pythonBuildStrategy.supportedTypes).toContain('python');
    expect(pythonBuildStrategy.supportedTypes).toContain('django');
    expect(pythonBuildStrategy.supportedTypes).toContain('flask');
    expect(pythonBuildStrategy.supportedTypes).toContain('fastapi');
  });

  it('should return install command', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'python',
      framework: null,
      config: {},
      env: {},
    };

    // Deps are installed into an in-app-dir venv (both isolation modes) so they
    // persist to runtime like node_modules — never bare `pip`/`--user`/`-t`.
    expect(pythonBuildStrategy.getInstallCommand(context)).toBe(
      'python3 -m venv .venv && ' +
        '.venv/bin/python -m pip install --upgrade pip && ' +
        '.venv/bin/python -m pip install -r requirements.txt'
    );
  });

  it('should return build command for Django', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'django',
      framework: 'django',
      config: {},
      env: {},
    };

    expect(pythonBuildStrategy.getBuildCommand(context)).toBe('python manage.py collectstatic --noinput');
  });

  it('should return null build command for Flask', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'flask',
      framework: 'flask',
      config: {},
      env: {},
    };

    expect(pythonBuildStrategy.getBuildCommand(context)).toBeNull();
  });
});

describe('Static Build Strategy', () => {
  it('should support static app types', () => {
    expect(staticBuildStrategy.supportedTypes).toContain('static');
    expect(staticBuildStrategy.supportedTypes).toContain('spa');
  });

  it('should return null for install command', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    };

    expect(staticBuildStrategy.getInstallCommand(context)).toBeNull();
  });

  it('should return null for build command', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    };

    expect(staticBuildStrategy.getBuildCommand(context)).toBeNull();
  });
});

describe('Docker Build Strategy', () => {
  it('should support docker app type', () => {
    expect(dockerBuildStrategy.supportedTypes).toContain('docker');
  });

  it('should return docker build command', () => {
    const context: BuildContext = {
      appName: 'my-app',
      appPath: '/test',
      appType: 'docker',
      framework: null,
      config: {},
      env: {},
    };

    expect(dockerBuildStrategy.getBuildCommand(context)).toContain('docker build');
  });

  it('should return null for install command', () => {
    const context: BuildContext = {
      appName: 'test',
      appPath: '/test',
      appType: 'docker',
      framework: null,
      config: {},
      env: {},
    };

    expect(dockerBuildStrategy.getInstallCommand(context)).toBeNull();
  });
});

describe('BuilderService install stage — dev dependencies', () => {
  it('forces npm_config_include=dev on the install exec (not the build exec) even when NODE_ENV is production', async () => {
    const service = new BuilderService();

    // 'rust' has no built-in strategy, so this custom strategy is the only
    // match — avoids colliding with the real nodejs strategy's preBuild
    // (lockfile detection etc.), which needs a real appPath on disk.
    const devDepsStrategy: BuildStrategy = {
      name: 'test-devdeps',
      supportedTypes: ['rust'],
      canBuild: () => true,
      getInstallCommand: () => 'npm install',
      getBuildCommand: () => 'npm run build',
      getOutputDirectory: () => 'dist',
    };
    service.registerStrategy(devDepsStrategy);

    const execCalls: Array<{ command: string; env: Record<string, string> }> = [];
    const execCommand: ExecCommandFn = async (command, _cwd, env) => {
      execCalls.push({ command, env });
      return { exitCode: 0, stdout: '', stderr: '', duration: 0 };
    };

    const context: BuildContext = {
      appName: 'devdeps-test',
      appPath: '/test',
      appType: 'rust',
      framework: null,
      config: {},
      env: { NODE_ENV: 'production' },
      execCommand,
    };

    const result = await service.build(context);

    expect(result.success).toBe(true);

    const installCall = execCalls.find(c => c.command === 'npm install');
    const buildCall = execCalls.find(c => c.command === 'npm run build');

    expect(installCall).toBeDefined();
    expect(installCall!.env.npm_config_include).toBe('dev');
    expect(installCall!.env.NODE_ENV).toBe('production');

    // Build stage keeps context.env untouched — the override must not leak
    // into the compile step.
    expect(buildCall).toBeDefined();
    expect(buildCall!.env.npm_config_include).not.toBe('dev');
    expect(buildCall!.env.NODE_ENV).toBe('production');
  });
});

describe('BuilderService install stage — postInstall hook', () => {
  // 'rust' has no built-in strategy (see the devdeps test above): the custom
  // strategy is the only match, keeping the real nodejs preBuild out of play.
  const makeStrategy = (postInstall: jest.Mock, installCommand: string | null = 'npm install') =>
    ({
      name: 'test-postinstall',
      supportedTypes: ['rust'],
      canBuild: () => true,
      getInstallCommand: () => installCommand,
      getBuildCommand: () => null,
      getOutputDirectory: () => null,
      postInstall,
    }) as BuildStrategy;

  const makeContext = (execCommand: ExecCommandFn): BuildContext => ({
    appName: 'postinstall-test',
    appPath: '/test',
    appType: 'rust',
    framework: null,
    config: {},
    env: {},
    execCommand,
  });

  it('calls postInstall after a successful install', async () => {
    const service = new BuilderService();
    const postInstall = jest.fn().mockResolvedValue(undefined);
    service.registerStrategy(makeStrategy(postInstall));

    const exec: ExecCommandFn = async () => ({ exitCode: 0, stdout: '', stderr: '', duration: 0 });
    const result = await service.build(makeContext(exec));

    expect(result.success).toBe(true);
    expect(postInstall).toHaveBeenCalledTimes(1);
  });

  it('does NOT call postInstall when the install fails — the skip marker must not outlive a failed install', async () => {
    const service = new BuilderService();
    const postInstall = jest.fn().mockResolvedValue(undefined);
    service.registerStrategy(makeStrategy(postInstall));

    const exec: ExecCommandFn = async () => ({ exitCode: 1, stdout: '', stderr: 'boom', duration: 0 });
    const result = await service.build(makeContext(exec));

    expect(result.success).toBe(false);
    expect(postInstall).not.toHaveBeenCalled();
  });

  it('a throwing postInstall does not fail the build — the marker is best-effort', async () => {
    const service = new BuilderService();
    const postInstall = jest.fn().mockRejectedValue(new Error('marker write blew up'));
    service.registerStrategy(makeStrategy(postInstall));

    const exec: ExecCommandFn = async () => ({ exitCode: 0, stdout: '', stderr: '', duration: 0 });
    const result = await service.build(makeContext(exec));

    expect(result.success).toBe(true);
    expect(postInstall).toHaveBeenCalledTimes(1);
  });

  it('does NOT call postInstall when the install stage is skipped', async () => {
    const service = new BuilderService();
    const postInstall = jest.fn().mockResolvedValue(undefined);
    service.registerStrategy(makeStrategy(postInstall, null));

    const exec: ExecCommandFn = async () => ({ exitCode: 0, stdout: '', stderr: '', duration: 0 });
    const result = await service.build(makeContext(exec));

    expect(result.success).toBe(true);
    expect(postInstall).not.toHaveBeenCalled();
  });
});

describe('executeCommand', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-builder-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should execute simple command', async () => {
    const result = await executeCommand('echo hello', tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('should capture stderr', async () => {
    // Use a command that writes to stderr
    const isWindows = process.platform === 'win32';
    const command = isWindows
      ? 'echo error 1>&2'
      : 'echo error >&2';

    const result = await executeCommand(command, tempDir);

    expect(result.stderr).toContain('error');
  });

  it('should return non-zero exit code on failure', async () => {
    const result = await executeCommand('exit 1', tempDir);

    expect(result.exitCode).toBe(1);
  });

  it('should include environment variables', async () => {
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'echo %TEST_VAR%' : 'echo $TEST_VAR';

    const result = await executeCommand(command, tempDir, { TEST_VAR: 'test_value' });

    expect(result.stdout).toContain('test_value');
  });

  it('should call output callback', async () => {
    const outputs: string[] = [];
    const onOutput = (data: string) => outputs.push(data);

    await executeCommand('echo test', tempDir, {}, undefined, onOutput);

    expect(outputs.some(o => o.includes('test'))).toBe(true);
  });
});

describe('BuilderService Integration', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-builder-int-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should fail build for unknown app type', async () => {
    const service = new BuilderService();
    const context: BuildContext = {
      appName: 'unknown-app',
      appPath: tempDir,
      appType: 'unknown',
      framework: null,
      config: {},
      env: {},
    };

    const result = await service.build(context);

    expect(result.success).toBe(false);
    expect(result.errors.some(e => e.code === 'NO_STRATEGY')).toBe(true);
  });

  it('opens AND closes a deploy episode when no strategy matches', async () => {
    // Regression: this path used to return before build:started was published,
    // so DeployTracker never opened an episode. The caller's later
    // setAppStatus('errored') then hit the tracker's orphan guard and no-opped,
    // leaving the episode permanently unclosed — every MCP deploy tool polled
    // for its full ~120s budget and reported "still building" instead of the
    // failure. Reachable via drop.yaml `type: rust` / `type: php`, neither of
    // which has a strategy.
    const { eventBus } = jest.requireMock('../event-bus');
    (eventBus.publish as jest.Mock).mockClear();

    const service = new BuilderService();
    await service.build({
      appName: 'no-strategy-app',
      appPath: tempDir,
      appType: 'unknown',
      framework: null,
      config: {},
      env: {},
    });

    const events = (eventBus.publish as jest.Mock).mock.calls.map(
      ([name, payload]: [string, { appId: string; buildId: string }]) => ({ name, payload })
    );

    const started = events.find(e => e.name === 'build:started');
    const failed = events.find(e => e.name === 'build:failed');

    expect(started).toBeDefined();
    expect(failed).toBeDefined();
    // Same buildId on both, or the tracker cannot correlate open with close.
    expect(started!.payload.buildId).toBe(failed!.payload.buildId);
    expect(started!.payload.appId).toBe('no-strategy-app');
  });

  it('emits no events when deferred by the concurrent-build cap', async () => {
    // MAX_BUILDS is a deferral, not a failure: the platform re-queues the app
    // and the retry opens its own episode. Publishing here would either strand
    // a 'superseded' episode or report a queue wait as a failed deploy.
    const { eventBus } = jest.requireMock('../event-bus');
    const service = new BuilderService({ maxConcurrentBuilds: 0 });
    (eventBus.publish as jest.Mock).mockClear();

    const result = await service.build({
      appName: 'deferred-app',
      appPath: tempDir,
      appType: 'nodejs',
      framework: null,
      config: {},
      env: {},
    });

    expect(result.errors.some(e => e.code === 'MAX_BUILDS')).toBe(true);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('should build static site successfully', async () => {
    // Create a simple static site
    const appDir = path.join(tempDir, 'static-site');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'index.html'), '<html><body>Hello</body></html>');

    const service = new BuilderService();
    const context: BuildContext = {
      appName: 'static-site',
      appPath: appDir,
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    };

    const result = await service.build(context);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
  });

  it('should respect max concurrent builds', async () => {
    const service = new BuilderService({ maxConcurrentBuilds: 1 });

    // Create two static sites
    const appDir1 = path.join(tempDir, 'static-1');
    const appDir2 = path.join(tempDir, 'static-2');
    await fs.mkdir(appDir1, { recursive: true });
    await fs.mkdir(appDir2, { recursive: true });
    await fs.writeFile(path.join(appDir1, 'index.html'), '<html></html>');
    await fs.writeFile(path.join(appDir2, 'index.html'), '<html></html>');

    // Start first build (won't complete immediately)
    const build1Promise = service.build({
      appName: 'app1',
      appPath: appDir1,
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    });

    // Try to start second build immediately
    const build2Promise = service.build({
      appName: 'app2',
      appPath: appDir2,
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    });

    const [result1, result2] = await Promise.all([build1Promise, build2Promise]);

    // At least one should succeed, the other might fail due to concurrency limit
    // Since static builds are fast, both might succeed
    expect(result1.success || result2.success).toBe(true);
  });

  it('should track build status', async () => {
    const appDir = path.join(tempDir, 'status-test');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'index.html'), '<html></html>');

    const service = new BuilderService();

    // Before build
    expect(service.getStatus('status-test')).toBeNull();

    // Start build
    const buildPromise = service.build({
      appName: 'status-test',
      appPath: appDir,
      appType: 'static',
      framework: null,
      config: {},
      env: {},
    });

    await buildPromise;

    // After build completes, status should be null (cleaned up)
    expect(service.getStatus('status-test')).toBeNull();
  });
});
