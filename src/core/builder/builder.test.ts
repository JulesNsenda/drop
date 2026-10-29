/**
 * Builder Service Tests
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// Mock event bus before importing builder
jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

import { BuilderService, createBuilderService, getBuilder, resetBuilder } from './builder';
import { BuildContext, BuildStrategy, DependencySettle, ExecCommandFn } from './builder.types';
import { parkedTreePaths } from './toolchain';
import { nodejsBuildStrategy } from './strategies/nodejs';
import { pythonBuildStrategy } from './strategies/python';
import { staticBuildStrategy } from './strategies/static';
import { dockerBuildStrategy } from './strategies/docker';
import { executeCommand } from './strategies/base';
import { itPosix, dirLink } from '../../utils/__testutils__/fs-links';

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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
    toolchainId: null,
    nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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

  it("carries the caller's trigger onto build:started", async () => {
    const { eventBus } = jest.requireMock('../event-bus');
    (eventBus.publish as jest.Mock).mockClear();

    const service = new BuilderService();
    await service.build({
      appName: 'trigger-app',
      appPath: tempDir,
      appType: 'unknown',
      framework: null,
      config: {},
      env: {},
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
      deployId: 'd-1',
      trigger: 'deploy',
    });

    const started = (eventBus.publish as jest.Mock).mock.calls.find(([name]: [string]) => name === 'build:started');
    expect(started![1]).toMatchObject({ appId: 'trigger-app', deployId: 'd-1', trigger: 'deploy' });
  });

  it('publishes the failing STAGE, not a constant (Gap A)', async () => {
    // builder.ts always knew which stage failed but published only
    // {appId, buildId, error}, so DeployTracker hardcoded a category. A
    // no-strategy failure is genuinely pre-build, and must say so.
    const { eventBus } = jest.requireMock('../event-bus');
    (eventBus.publish as jest.Mock).mockClear();

    const service = new BuilderService();
    await service.build({
      appName: 'stage-app',
      appPath: tempDir,
      appType: 'unknown',
      framework: null,
      config: {},
      env: {},
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    });

    const failed = (eventBus.publish as jest.Mock).mock.calls.find(
      ([name]: [string]) => name === 'build:failed'
    );
    expect(failed![1].stage).toBe('pre-build');
  });

  it('carries the failing command and exit code off a real stage failure', async () => {
    // executeInstall/executeBuild have always held both; they stopped at the
    // BuildStageResult and never reached the payload.
    const { eventBus } = jest.requireMock('../event-bus');
    (eventBus.publish as jest.Mock).mockClear();

    const service = new BuilderService();
    const execCommand = jest.fn().mockResolvedValue({
      exitCode: 127,
      stdout: '',
      stderr: 'sh: vite: not found',
      duration: 3,
    });

    await service.build({
      appName: 'cmd-app',
      appPath: tempDir,
      appType: 'nodejs',
      framework: null,
      config: { buildCommand: 'npm run build', installCommand: 'npm ci' },
      env: {},
      execCommand,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    } as never);

    const failed = (eventBus.publish as jest.Mock).mock.calls.find(
      ([name]: [string]) => name === 'build:failed'
    );
    expect(failed![1].exitCode).toBe(127);
    expect(typeof failed![1].command).toBe('string');
    expect(failed![1].command.length).toBeGreaterThan(0);
    // Still a real stage, not the 'build' default.
    expect(['install', 'build']).toContain(failed![1].stage);
  });

  it('truncates an oversized command rather than publishing it whole', async () => {
    // drop.yaml `build` is app-authored and unbounded, and this value ends up
    // in a persisted deploy row.
    const { eventBus } = jest.requireMock('../event-bus');
    (eventBus.publish as jest.Mock).mockClear();

    const service = new BuilderService();
    const huge = 'x'.repeat(5000);
    const execCommand = jest.fn().mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
      duration: 3,
    });

    await service.build({
      appName: 'huge-cmd-app',
      appPath: tempDir,
      appType: 'nodejs',
      framework: null,
      config: { buildCommand: huge, installCommand: huge },
      env: {},
      execCommand,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    } as never);

    const failed = (eventBus.publish as jest.Mock).mock.calls.find(
      ([name]: [string]) => name === 'build:failed'
    );
    expect(failed![1].command.length).toBe(512);
  });

  describe('concurrent-build cap', () => {
    // A cap-full build WAITS for a slot (FIFO) instead of failing: a refusal
    // used to lose redeploys of running apps that nothing retried. 'rust' has no
    // built-in strategy, so the gated custom strategy below is the only match.
    const { eventBus } = jest.requireMock('../event-bus');
    let started: string[];
    let live: number;
    let peak: number;
    let gates: Map<string, () => void>;
    let throwFor: Set<string>;

    const makeService = (maxConcurrentBuilds: number): BuilderService => {
      const service = new BuilderService({ maxConcurrentBuilds });
      service.registerStrategy({
        name: 'gated',
        supportedTypes: ['rust'],
        canBuild: () => true,
        getInstallCommand: () => null,
        getBuildCommand: () => null,
        getOutputDirectory: () => null,
        preBuild: async (context: BuildContext) => {
          started.push(context.appName);
          live++;
          peak = Math.max(peak, live);
          try {
            if (throwFor.has(context.appName)) throw new Error('strategy blew up');
            await new Promise<void>((resolve) => gates.set(context.appName, resolve));
          } finally {
            live--;
          }
        },
      } as BuildStrategy);
      return service;
    };

    const ctx = (appName: string): BuildContext => ({
      appName,
      appPath: tempDir,
      appType: 'rust',
      framework: null,
      config: {},
      env: {},
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    });

    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const finish = async (appName: string) => {
      gates.get(appName)!();
      gates.delete(appName);
      await tick();
    };
    const startedEvents = () =>
      (eventBus.publish as jest.Mock).mock.calls
        .filter(([name]: [string]) => name === 'build:started')
        .map(([, payload]: [string, { appId: string }]) => payload.appId);

    beforeEach(() => {
      started = [];
      live = 0;
      peak = 0;
      gates = new Map();
      throwFor = new Set();
      (eventBus.publish as jest.Mock).mockClear();
    });

    it('a second build waits and starts only after the first finishes', async () => {
      const service = makeService(1);
      const first = service.build(ctx('a'));
      const second = service.build(ctx('b'));
      await tick();

      expect(started).toEqual(['a']);
      expect(startedEvents()).toEqual(['a']);

      await finish('a');
      expect((await first).errors.some((e) => e.code === 'MAX_BUILDS')).toBe(false);
      expect(started).toEqual(['a', 'b']);

      await finish('b');
      expect((await second).success).toBe(true);
    });

    it('starts three builds at cap 1 in FIFO order', async () => {
      const service = makeService(1);
      const results = [service.build(ctx('a')), service.build(ctx('b')), service.build(ctx('c'))];
      await tick();
      expect(started).toEqual(['a']);

      await finish('a');
      expect(started).toEqual(['a', 'b']);
      await finish('b');
      expect(started).toEqual(['a', 'b', 'c']);
      await finish('c');

      expect((await Promise.all(results)).every((r) => r.success)).toBe(true);
    });

    it('a throwing strategy frees its slot so the waiter proceeds', async () => {
      const service = makeService(1);
      throwFor.add('a');
      const first = service.build(ctx('a'));
      const second = service.build(ctx('b'));
      await tick();

      expect((await first).success).toBe(false);
      expect(started).toEqual(['a', 'b']);
      await finish('b');
      expect((await second).success).toBe(true);
    });

    it('cap 0 means unlimited: nothing waits', async () => {
      const service = makeService(0);
      const names = ['a', 'b', 'c', 'd', 'e'];
      const all = names.map((n) => service.build(ctx(n)));
      await tick();

      expect(started).toEqual(names);
      for (const n of names) await finish(n);
      expect((await Promise.all(all)).every((r) => r.success)).toBe(true);
    });

    it('a NaN cap is unlimited too', async () => {
      const service = makeService(NaN);
      const all = [service.build(ctx('a')), service.build(ctx('b'))];
      await tick();

      expect(started).toEqual(['a', 'b']);
      await finish('a');
      await finish('b');
      await Promise.all(all);
    });

    it('a waiter publishes no build:started until it holds the slot', async () => {
      const service = makeService(1);
      const first = service.build(ctx('a'));
      const second = service.build(ctx('b'));
      await tick();
      expect(startedEvents()).toEqual(['a']);
      expect(
        (eventBus.publish as jest.Mock).mock.calls.some(
          ([, payload]: [string, { appId: string }]) => payload.appId === 'b'
        )
      ).toBe(false);

      await finish('a');
      expect(startedEvents()).toEqual(['a', 'b']);
      await finish('b');
      await Promise.all([first, second]);
    });

    it('refuses a second build of an app that is running or waiting with BUILD_IN_PROGRESS', async () => {
      const service = makeService(1);
      const running = service.build(ctx('a'));
      const waiting = service.build(ctx('b'));
      await tick();

      const dupRunning = await service.build(ctx('a'));
      const dupWaiting = await service.build(ctx('b'));
      expect(dupRunning.errors[0].code).toBe('BUILD_IN_PROGRESS');
      expect(dupWaiting.errors[0].code).toBe('BUILD_IN_PROGRESS');

      await finish('a');
      // 'b' now holds the slot (no longer waiting) and is still refused.
      expect((await service.build(ctx('b'))).errors[0].code).toBe('BUILD_IN_PROGRESS');
      await finish('b');
      await Promise.all([running, waiting]);
      // Gone from both sets once done: a fresh build is accepted.
      const again = service.build(ctx('b'));
      await tick();
      expect(started).toEqual(['a', 'b', 'b']);
      await finish('b');
      expect((await again).success).toBe(true);
    });

    it('reserveSlot grants FIFO under the cap and its release is idempotent', async () => {
      const service = makeService(1);
      const order: string[] = [];
      const releaseA = await service.reserveSlot('a');
      const pb = service.reserveSlot('b').then((r) => (order.push('b'), r));
      const pc = service.reserveSlot('c').then((r) => (order.push('c'), r));
      await tick();
      expect(order).toEqual([]);

      releaseA();
      releaseA(); // a double release must not hand out a second slot
      await tick();
      expect(order).toEqual(['b']);

      (await pb)();
      await tick();
      expect(order).toEqual(['b', 'c']);
      (await pc)();
    });

    it('build with slotReserved neither waits nor releases the caller slot', async () => {
      const service = makeService(1);
      const release = await service.reserveSlot('a');
      let secondGranted = false;
      const second = service.reserveSlot('b').then((r) => ((secondGranted = true), r));

      // Cap is full, yet the build of the reserving app starts at once.
      const built = service.build({ ...ctx('a'), slotReserved: true });
      await tick();
      expect(started).toEqual(['a']);

      await finish('a');
      expect((await built).success).toBe(true);
      await tick();
      expect(secondGranted).toBe(false); // build() did not free the caller's slot

      release();
      (await second)();
      expect(secondGranted).toBe(true);
    });

    it('duration excludes the time spent waiting for a slot', async () => {
      const service = makeService(1);
      const first = service.build(ctx('a'));
      const second = service.build(ctx('b'));
      const queuedAt = Date.now();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 200));

      await finish('a');
      await first;
      const waited = Date.now() - queuedAt;
      await finish('b');
      const result = await second;
      expect(result.success).toBe(true);
      // Measured against the actual wait, not an absolute bound.
      expect(result.duration).toBeLessThan(waited);
    });

    it('a NO_STRATEGY build returns at once under a full cap', async () => {
      const service = new BuilderService({ maxConcurrentBuilds: 1 });
      const release = await service.reserveSlot('holder');

      const result = await service.build(ctx('nostrat'));

      expect(result.errors[0].code).toBe('NO_STRATEGY');
      release();
    });

    it('a build() of an app that is waiting in reserveSlot gets BUILD_IN_PROGRESS', async () => {
      const service = makeService(1);
      const release = await service.reserveSlot('holder');
      const waiting = service.reserveSlot('b');
      await tick();

      const result = await service.build(ctx('b'));
      expect(result.errors[0].code).toBe('BUILD_IN_PROGRESS');

      release();
      (await waiting)();
    });

    it('never exceeds the cap under concurrent calls', async () => {
      const service = makeService(2);
      const names = ['a', 'b', 'c', 'd', 'e', 'f'];
      const all = names.map((n) => service.build(ctx(n)));
      await tick();

      for (const n of names) {
        await tick();
        await finish(n);
        expect(peak).toBeLessThanOrEqual(2);
      }
      expect((await Promise.all(all)).every((r) => r.success)).toBe(true);
      expect(peak).toBe(2);
    });
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    });

    // Start the second build immediately: it waits for the first's slot
    const build2Promise = service.build({
      appName: 'app2',
      appPath: appDir2,
      appType: 'static',
      framework: null,
      config: {},
      env: {},
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    });

    const [result1, result2] = await Promise.all([build1Promise, build2Promise]);

    // The second waits for the slot instead of failing on the cap, so both succeed.
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
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
      execCommand: undefined,
      toolchainId: null,
      nodeModulesAsideDir: undefined,
    });

    await buildPromise;

    // After build completes, status should be null (cleaned up)
    expect(service.getStatus('status-test')).toBeNull();
  });
});

describe('BuilderService — the dependency step handle', () => {
  // 'rust' has no built-in strategy, so a custom strategy is the only match.
  const ok = { exitCode: 0, stdout: '', stderr: '', duration: 0 };
  const okExec: ExecCommandFn = async () => ok;

  const makeHandle = (): { settle: DependencySettle; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      settle: {
        beforeInstall: jest.fn(async () => undefined),
        commit: jest.fn(async () => void calls.push('commit')),
        rollback: jest.fn(async () => void calls.push('rollback')),
      },
    };
  };

  const makeStrategy = (
    prepare: BuildStrategy['prepareDependencies'],
    overrides: Partial<BuildStrategy> = {}
  ): BuildStrategy => ({
    name: 'test-deps-handle',
    supportedTypes: ['rust'],
    canBuild: () => true,
    getInstallCommand: () => 'npm install',
    getBuildCommand: () => 'npm run build',
    getOutputDirectory: () => null,
    prepareDependencies: prepare,
    ...overrides,
  });

  const makeContext = (execCommand: ExecCommandFn, config: BuildContext['config'] = {}): BuildContext => ({
    appName: 'handle-test',
    appPath: '/test',
    appType: 'rust',
    framework: null,
    config,
    env: {},
    execCommand,
    toolchainId: null,
    nodeModulesAsideDir: undefined,
  });

  const run = async (
    strategy: BuildStrategy,
    exec: ExecCommandFn = okExec
  ): Promise<{ result: Awaited<ReturnType<BuilderService['build']>>; lines: string[] }> => {
    const service = new BuilderService();
    service.registerStrategy(strategy);
    const lines: string[] = [];
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const context = { ...makeContext(exec), onBuildLog: (l: string) => lines.push(l) };
    const result = await service.build(context);
    return { result, lines };
  };

  afterEach(() => jest.restoreAllMocks());

  it('commits exactly once when every stage passed and the install ran', async () => {
    const { settle, calls } = makeHandle();
    const { result } = await run(makeStrategy(async () => settle));
    expect(result.success).toBe(true);
    expect(calls).toEqual(['commit']);
  });

  it.each([
    ['an install that exits non-zero', async (cmd: string) => (cmd === 'npm install' ? { ...ok, exitCode: 1, stderr: 'boom' } : ok)],
    ['an install that throws', async (cmd: string) => { if (cmd === 'npm install') throw new Error('timed out'); return ok; }],
    ['a build command that fails', async (cmd: string) => (cmd === 'npm run build' ? { ...ok, exitCode: 1, stderr: 'boom' } : ok)],
  ])('rolls back exactly once for %s', async (_name, exec) => {
    const { settle, calls } = makeHandle();
    const { result } = await run(makeStrategy(async () => settle), exec as ExecCommandFn);
    expect(result.success).toBe(false);
    expect(calls).toEqual(['rollback']);
  });

  it('rolls back when a post-build stage fails after a successful install', async () => {
    const { settle, calls } = makeHandle();
    const { result } = await run(
      makeStrategy(async () => settle, { getBuildCommand: () => null, validate: async () => false })
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].stage).toBe('validate');
    expect(calls).toEqual(['rollback']);
  });

  it('commits when the install stage is skipped but the whole build succeeded', async () => {
    const { settle, calls } = makeHandle();
    const { result } = await run(makeStrategy(async () => settle, { getInstallCommand: () => null }));
    expect(result.success).toBe(true);
    expect(calls).toEqual(['commit']);
  });

  it('settles on a pre-build throw too, after the dependency step returned', async () => {
    const { settle, calls } = makeHandle();
    const { result } = await run(
      makeStrategy(async () => settle, {
        preBuild: async () => {
          throw new Error('pre boom');
        },
      })
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].stage).toBe('pre-build');
    expect(calls).toEqual(['rollback']);
  });

  it('a throwing dependency step fails pre-build and leaves nothing to settle', async () => {
    const { result } = await run(
      makeStrategy(async () => {
        throw new Error('could not move');
      })
    );
    expect(result.success).toBe(false);
    expect(result.errors[0].stage).toBe('pre-build');
    expect(result.errors[0].message).toBe('could not move');
  });

  it('a strategy without a handle (void) builds as before', async () => {
    const { result } = await run(makeStrategy(async () => undefined));
    expect(result.success).toBe(true);
  });

  it('passes the handle to postInstall, so the strategy can read what it may stamp', async () => {
    const { settle } = makeHandle();
    const postInstall = jest.fn().mockResolvedValue(undefined);
    await run(makeStrategy(async () => settle, { postInstall }));
    expect(postInstall).toHaveBeenCalledTimes(1);
    expect(postInstall.mock.calls[0][1]).toBe(settle);
  });

  it('calls beforeInstall exactly once, after the strategy preBuild and right before the install command', async () => {
    const { settle } = makeHandle();
    const order: string[] = [];
    (settle.beforeInstall as jest.Mock).mockImplementation(async () => void order.push('beforeInstall'));
    const exec: ExecCommandFn = async (cmd) => {
      order.push(cmd);
      return ok;
    };
    const { result } = await run(
      makeStrategy(async () => settle, { preBuild: async () => void order.push('preBuild') }),
      exec
    );
    expect(result.success).toBe(true);
    expect(order).toEqual(['preBuild', 'beforeInstall', 'npm install', 'npm run build']);
    expect(settle.beforeInstall).toHaveBeenCalledTimes(1);
  });

  it('does not call beforeInstall when the install is skipped', async () => {
    const { settle, calls } = makeHandle();
    const { result } = await run(makeStrategy(async () => settle, { getInstallCommand: () => null }));
    expect(result.success).toBe(true);
    expect(settle.beforeInstall).not.toHaveBeenCalled();
    expect(calls).toEqual(['commit']);
  });

  it('a beforeInstall that throws fails the install stage without running the install, and rolls back', async () => {
    const { settle, calls } = makeHandle();
    (settle.beforeInstall as jest.Mock).mockRejectedValue(new Error('look failed'));
    const exec = jest.fn(async () => ok);
    const { result } = await run(makeStrategy(async () => settle), exec as ExecCommandFn);
    expect(result.success).toBe(false);
    expect(result.errors[0].stage).toBe('install');
    expect(exec).not.toHaveBeenCalled();
    expect(calls).toEqual(['rollback']);
  });

  it('a build cancelled during pre-build ROLLS BACK and reports a failure, though every stage ran', async () => {
    const { settle, calls } = makeHandle();
    const service = new BuilderService();
    service.registerStrategy(
      makeStrategy(async () => settle, {
        // The drop.yaml hooks and validate ignore the abort signal: the build
        // runs on to the end, and must not then commit (or report success for)
        // a tree that was just rolled back.
        preBuild: async () => service.cancel('handle-test'),
      })
    );
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.build(makeContext(okExec));

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('CANCELLED');
    expect(calls).toEqual(['rollback']);
  });

  it('refuses a second concurrent build of the SAME app: no events, no dependency step', async () => {
    const { eventBus } = jest.requireMock('../event-bus');
    const publish = eventBus.publish as jest.Mock;
    const { settle, calls } = makeHandle();
    const prepare = jest.fn(async () => settle);
    let releaseInstall!: () => void;
    const gate = new Promise<void>((resolve) => (releaseInstall = resolve));
    const service = new BuilderService();
    service.registerStrategy(makeStrategy(prepare));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = service.build(
      makeContext(async (cmd) => {
        if (cmd === 'npm install') await gate;
        return ok;
      })
    );
    // build() runs synchronously up to its first await, so the first build is
    // registered by now and its started event published.
    expect(service.getStatus('handle-test')).toBe('running');
    publish.mockClear();

    const secondPromise = service.build(makeContext(okExec));
    expect(publish).not.toHaveBeenCalled();
    const second = await secondPromise;

    expect(second.success).toBe(false);
    expect(second.errors).toHaveLength(1);
    expect(second.errors[0]).toMatchObject({ stage: 'pre-build', code: 'BUILD_IN_PROGRESS' });
    expect(prepare).toHaveBeenCalledTimes(1);

    // The refusal left the first build alone, and the slot is free afterwards.
    releaseInstall();
    expect((await first).success).toBe(true);
    expect(calls).toEqual(['commit']);
    expect((await service.build(makeContext(okExec))).success).toBe(true);
    publish.mockReset();
  });

  it('settles BEFORE build:completed is published, so a start sees the finished tree', async () => {
    const { eventBus } = jest.requireMock('../event-bus');
    const order: string[] = [];
    (eventBus.publish as jest.Mock).mockImplementation((name: string) => {
      if (name === 'build:completed') order.push('completed');
    });
    const { settle } = makeHandle();
    (settle.commit as jest.Mock).mockImplementation(async () => void order.push('commit'));
    await run(makeStrategy(async () => settle));
    (eventBus.publish as jest.Mock).mockReset();
    expect(order).toEqual(['commit', 'completed']);
  });

  it.each(['commit', 'rollback'] as const)(
    'a %s that throws is logged generically and never replaces the build result',
    async (which) => {
      const { settle } = makeHandle();
      (settle[which] as jest.Mock).mockRejectedValue(new Error('EACCES: /host/secret/path'));
      const exec: ExecCommandFn = async (cmd) =>
        which === 'rollback' && cmd === 'npm install' ? { ...ok, exitCode: 1, stderr: 'boom' } : ok;
      const { result, lines } = await run(makeStrategy(async () => settle), exec);

      expect(result.success).toBe(which === 'commit');
      if (which === 'rollback') expect(result.errors[0].message).toContain('boom');
      expect(lines.join('\n')).toMatch(/previous dependencies/);
      expect(lines.join('\n')).not.toContain('/host/secret');
    }
  );
});

describe('BuilderService + nodejs strategy — toolchain freshness', () => {
  const ID = 'node-abi-127-linux-x64-glibc';
  const OLD = 'node-abi-115-linux-x64-glibc';
  const ok = { exitCode: 0, stdout: '', stderr: '', duration: 0 };
  const realFs = jest.requireActual('fs/promises');
  let appDir: string;
  let asideRoot: string;
  let aside: string;

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-builder-toolchain-'));
    asideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-builder-aside-'));
    aside = path.join(asideRoot, 'toolchain-app');
    await fs.writeFile(path.join(appDir, 'package.json'), '{"name":"app"}');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(asideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // `aside` is the aside ROOT: the parked tree sits in the slot of the build's
  // own path under it.
  const parkedDir = (): string => parkedTreePaths(appDir, aside).parked;
  // Nothing parked and nothing waiting for deletion in any slot.
  const asideGone = async (): Promise<boolean> => {
    const slots = await fs.readdir(aside).catch(() => [] as string[]);
    for (const slot of slots) {
      const inside = await fs.readdir(path.join(aside, slot)).catch(() => [] as string[]);
      if (inside.length > 0) return false;
    }
    return true;
  };
  const modules = (): string => path.join(appDir, 'node_modules');
  const markerPath = (): string => path.join(modules(), '.drop-toolchain');
  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false
    );
  const listing = async (): Promise<string[]> => (await fs.readdir(modules())).sort();
  const marker = async (): Promise<string> => (await fs.readFile(markerPath(), 'utf-8')).trim();

  // A node_modules from an earlier install: one package, optionally stamped.
  const seed = async (stamp?: string): Promise<void> => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), 'pkg.txt'), 'x');
    if (stamp !== undefined) await fs.writeFile(markerPath(), stamp);
  };

  // nextjs: the nodejs strategy, with a build command ('npm run build') and a
  // `.next` output that validate() checks.
  const makeContext = (
    execCommand: ExecCommandFn,
    overrides: Partial<BuildContext> = {}
  ): BuildContext => ({
    appName: 'toolchain-app',
    appPath: appDir,
    appType: 'nextjs',
    framework: null,
    // What the Node detector supplies in production.
    config: { installCommand: 'npm install' },
    env: {},
    nodeModulesAsideDir: aside,
    execCommand,
    toolchainId: ID,
    ...overrides,
  });

  // What a real install does: recreate node_modules with the new dependency.
  const installFresh = async (): Promise<void> => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), 'new.txt'), 'n');
  };
  const buildOutput = async (): Promise<void> => {
    await fs.mkdir(path.join(appDir, '.next'), { recursive: true });
  };

  const restored = ['.drop-toolchain', 'pkg.txt'];

  describe('every exit path leaves the tree and the marker settled', () => {
    type Row = [
      string,
      Partial<BuildContext['config']>,
      (cmd: string) => Promise<typeof ok>,
      { success: boolean; files: string[]; stamp: string; ran?: string[]; setup?: () => void },
    ];

    const rows: Row[] = [
      [
        'a hook that exits non-zero',
        { installCommand: 'npm install', preBuild: ['bad-hook'] },
        async (cmd) => (cmd === 'bad-hook' ? { ...ok, exitCode: 2, stderr: 'nope' } : ok),
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'a hook that throws',
        { installCommand: 'npm install', preBuild: ['throw-hook'] },
        async (cmd) => {
          if (cmd === 'throw-hook') throw new Error('hook blew up');
          return ok;
        },
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'a strategy preBuild that throws',
        { installCommand: 'npm install' },
        async () => ok,
        {
          success: false,
          files: restored,
          stamp: OLD,
          setup: () => {
            jest.spyOn(nodejsBuildStrategy, 'preBuild').mockRejectedValueOnce(new Error('pre boom'));
          },
        },
      ],
      [
        'an install skipped after the tree was moved (a hook forged a matching tree)',
        // No installCommand: preBuild's lockfile skip decides, and the forged
        // tree below is exactly what it would trust without the toolchain check.
        { preBuild: ['forge'] },
        async (cmd) => {
          if (cmd === 'forge') {
            await fs.mkdir(modules(), { recursive: true });
            await fs.writeFile(path.join(modules(), 'forged.txt'), 'f');
            await fs.writeFile(markerPath(), ID);
            await fs.writeFile(
              path.join(modules(), '.drop-lockfile-hash'),
              crypto.createHash('sha256').update('lock').digest('hex')
            );
          }
          if (cmd === 'npm run build') await buildOutput();
          return ok;
        },
        // The hook-restored matching tree is kept and the aside is discarded.
        {
          success: true,
          files: ['.drop-lockfile-hash', '.drop-toolchain', 'forged.txt'],
          stamp: ID,
        },
      ],
      [
        'an install that exits non-zero',
        { installCommand: 'npm install' },
        async (cmd) => {
          if (cmd === 'npm install') {
            await installFresh();
            return { ...ok, exitCode: 1, stderr: 'boom' };
          }
          return ok;
        },
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'an install that throws',
        { installCommand: 'npm install' },
        async (cmd) => {
          if (cmd === 'npm install') {
            await installFresh();
            throw new Error('Command timed out after 600000ms');
          }
          return ok;
        },
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'a build command that fails after a good install',
        { installCommand: 'npm install' },
        async (cmd) => {
          if (cmd === 'npm install') {
            await installFresh();
            return ok;
          }
          return { ...ok, exitCode: 1, stderr: 'build boom' };
        },
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'validation that fails after a good install and build',
        { installCommand: 'npm install' },
        async (cmd) => {
          if (cmd === 'npm install') await installFresh();
          return ok;
        },
        { success: false, files: restored, stamp: OLD },
      ],
      [
        'success',
        { installCommand: 'npm install' },
        async (cmd) => {
          if (cmd === 'npm install') await installFresh();
          if (cmd === 'npm run build') await buildOutput();
          return ok;
        },
        // The lockfile hash is written after the stamp, beside it.
        {
          success: true,
          files: ['.drop-lockfile-hash', '.drop-toolchain', 'new.txt'],
          stamp: ID,
        },
      ],
    ];

    it.each(rows)('%s', async (_name, config, impl, expected) => {
      await seed(OLD);
      await fs.writeFile(path.join(appDir, 'package-lock.json'), 'lock');
      expected.setup?.();
      const ran: string[] = [];
      const exec: ExecCommandFn = async (command) => {
        ran.push(command);
        return impl(command);
      };

      const result = await new BuilderService().build(makeContext(exec, { config: { ...config } }));

      expect(result.success).toBe(expected.success);
      expect(await listing()).toEqual(expected.files);
      expect(await marker()).toBe(expected.stamp);
      expect(await asideGone()).toBe(true);
      if (_name.startsWith('an install skipped')) {
        // The skip really was taken: no package-manager command ran.
        expect(ran.filter((c) => c.startsWith('npm i') || c.startsWith('npm c'))).toEqual([]);
      }
    });

    it('a failed install keeps its own error, with the original tree back', async () => {
      await seed(OLD);
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') {
          await installFresh();
          return { ...ok, exitCode: 1, stderr: 'boom' };
        }
        return ok;
      };
      const result = await new BuilderService().build(makeContext(exec));
      expect(result.errors[0].stage).toBe('install');
      expect(result.errors[0].message).toContain('boom');
    });

    it('a restore that cannot be done is logged and never masks the install failure', async () => {
      await seed(OLD);
      const lines: string[] = [];
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') {
          // Make the restore impossible: the moved-aside tree is gone.
          await fs.rm(parkedDir(), { recursive: true, force: true });
          return { ...ok, exitCode: 1, stderr: 'boom' };
        }
        return ok;
      };
      const result = await new BuilderService().build(
        makeContext(exec, { onBuildLog: (l) => lines.push(l) })
      );
      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('boom');
      expect(lines.join('\n')).toMatch(/Could not restore the previous dependencies/);
    });
  });

  describe('what a stamp means', () => {
    it('an UNMARKED tree is moved aside, the install runs from empty, and the new tree is stamped', async () => {
      await seed();
      let modulesAtInstall: boolean | null = null;
      let asideAtInstall: boolean | null = null;
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') {
          modulesAtInstall = await exists(modules());
          asideAtInstall = await exists(path.join(parkedDir(), 'pkg.txt'));
          await installFresh();
        }
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(makeContext(exec));

      expect(result.success).toBe(true);
      expect(modulesAtInstall).toBe(false);
      expect(asideAtInstall).toBe(true);
      expect(await listing()).toEqual(['.drop-toolchain', 'new.txt']);
      expect(await marker()).toBe(ID);
      expect(await asideGone()).toBe(true);
    });

    it('a tree that does not exist yet is installed from empty and stamped', async () => {
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') await installFresh();
        if (command === 'npm run build') await buildOutput();
        return ok;
      };
      const result = await new BuilderService().build(makeContext(exec));
      expect(result.success).toBe(true);
      expect(await marker()).toBe(ID);
    });

    it('a symlinked node_modules (refused) is never moved and never stamped', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-builder-outside-'));
      try {
        await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
        await dirLink(outside, modules());
        const exec: ExecCommandFn = async (command) => {
          if (command === 'npm run build') await buildOutput();
          return ok;
        };

        const result = await new BuilderService().build(makeContext(exec));

        expect(result.success).toBe(true);
        expect((await fs.lstat(modules())).isSymbolicLink()).toBe(true);
        expect(await fs.readdir(outside)).toEqual(['keep.txt']);
        expect(await asideGone()).toBe(true);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    itPosix('a linked toolchain marker (refused) is never moved, never stamped, and never lets the lockfile skip', async () => {
      await seed();
      await fs.writeFile(path.join(appDir, 'package-lock.json'), 'lock');
      await fs.writeFile(
        path.join(modules(), '.drop-lockfile-hash'),
        crypto.createHash('sha256').update('lock').digest('hex')
      );
      const target = path.join(asideRoot, 'target');
      await fs.writeFile(target, ID);
      await fs.symlink(target, markerPath());
      const ran: string[] = [];
      const exec: ExecCommandFn = async (command) => {
        ran.push(command);
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(makeContext(exec, { config: {} }));

      expect(result.success).toBe(true);
      expect(ran).toContain('npm ci');
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect((await fs.lstat(markerPath())).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, 'utf-8')).toBe(ID);
      expect(await asideGone()).toBe(true);
    });

    it('a matching tree with a matching lockfile hash still skips the install', async () => {
      await seed(ID);
      await fs.writeFile(path.join(appDir, 'package-lock.json'), 'lock');
      await fs.writeFile(
        path.join(modules(), '.drop-lockfile-hash'),
        crypto.createHash('sha256').update('lock').digest('hex')
      );
      const ran: string[] = [];
      const exec: ExecCommandFn = async (command) => {
        ran.push(command);
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(makeContext(exec, { config: {} }));

      expect(result.success).toBe(true);
      expect(ran).toEqual(['npm run build']);
      expect(await listing()).toEqual(['.drop-lockfile-hash', '.drop-toolchain', 'pkg.txt']);
      expect(await marker()).toBe(ID);
    });

    it('an UNKNOWN toolchain (null) with a JS install: only the toolchain marker is removed, no wipe, no stamp', async () => {
      await seed(OLD);
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(makeContext(exec, { toolchainId: null }));

      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['pkg.txt']);
      expect(await asideGone()).toBe(true);
    });

    it('a stale tree with no JS install to follow loses only its marker', async () => {
      await seed(OLD);
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(
        makeContext(exec, { config: { installCommand: 'make deps' } })
      );

      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['pkg.txt']);
      expect(await asideGone()).toBe(true);
    });
  });

  describe('the move and its fallbacks', () => {
    it('removes a stale tree in place on EXDEV, installs fresh and stamps', async () => {
      await seed(OLD);
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }));
      const lines: string[] = [];
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') await installFresh();
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(
        makeContext(exec, { onBuildLog: (l) => lines.push(l) })
      );

      expect(rename).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['.drop-toolchain', 'new.txt']);
      expect(await marker()).toBe(ID);
      expect(lines.some((l) => /removed in place/.test(l))).toBe(true);
    });

    it('with an EXDEV removal, a failed install cannot restore the tree (said in the log)', async () => {
      await seed(OLD);
      jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
      const exec: ExecCommandFn = async (command) =>
        command === 'npm install' ? { ...ok, exitCode: 1, stderr: 'boom' } : ok;

      const result = await new BuilderService().build(makeContext(exec));

      expect(result.success).toBe(false);
      expect(await exists(modules())).toBe(false);
    });

    it('removes a stale tree in place when the build has no aside dir', async () => {
      await seed(OLD);
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm install') await installFresh();
        if (command === 'npm run build') await buildOutput();
        return ok;
      };
      const result = await new BuilderService().build(
        makeContext(exec, { nodeModulesAsideDir: undefined })
      );
      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['.drop-toolchain', 'new.txt']);
      expect(await marker()).toBe(ID);
    });

    it('FAILS the build with the tree untouched when the rename fails for any other reason (EPERM)', async () => {
      await seed(OLD);
      jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(
          Object.assign(new Error(`EPERM: operation not permitted, rename '${appDir}'`), {
            code: 'EPERM',
          })
        );
      const exec = jest.fn().mockResolvedValue(ok);

      const result = await new BuilderService().build(makeContext(exec));

      expect(result.success).toBe(false);
      expect(result.errors[0].stage).toBe('pre-build');
      expect(result.errors[0].message).toBe(
        'could not move node_modules built for a different Node runtime'
      );
      expect(result.errors[0].message).not.toContain(appDir);
      expect(exec).not.toHaveBeenCalled();
      expect(await listing()).toEqual(restored);
      expect(await marker()).toBe(OLD);
    });

    it('fails the build, without running the install, when the tree can be neither moved nor removed', async () => {
      await seed(OLD);
      const exec = jest.fn().mockResolvedValue(ok);
      const tenantFile = jest.requireActual('../../utils/tenant-file');
      jest.spyOn(tenantFile, 'removeTenantPath').mockRejectedValue(new Error('EACCES: /host/secret'));

      // No aside dir: the move is not tried, so the in-place removal is the only way.
      const result = await new BuilderService().build(
        makeContext(exec, { nodeModulesAsideDir: undefined })
      );

      expect(result.success).toBe(false);
      expect(result.errors[0].stage).toBe('pre-build');
      expect(result.errors[0].message).toMatch(/could not remove node_modules/);
      expect(result.errors[0].message).not.toContain('/host/secret');
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('a drop.yaml hook that recreates node_modules before the install', () => {
    const hookedExec = (hook: () => Promise<void>): ExecCommandFn => async (command) => {
      if (command === 'cache-restore') await hook();
      if (command === 'npm install') {
        await fs.mkdir(modules(), { recursive: true });
        await fs.writeFile(path.join(modules(), 'new.txt'), 'n');
      }
      if (command === 'npm run build') await buildOutput();
      return ok;
    };
    const withHook = { installCommand: 'npm install', preBuild: ['cache-restore'] };
    const restoreUnmarked = async (): Promise<void> => {
      await fs.mkdir(modules(), { recursive: true });
      await fs.writeFile(path.join(modules(), 'cached.txt'), 'c');
    };

    it('after a MOVE: the install runs over the unmarked tree and nothing is stamped', async () => {
      await seed(OLD);
      const result = await new BuilderService().build(
        makeContext(hookedExec(restoreUnmarked), { config: { ...withHook } })
      );
      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['cached.txt', 'new.txt']);
      expect(await exists(markerPath())).toBe(false);
      expect(await asideGone()).toBe(true);
    });

    it('over a tree that had no node_modules: nothing is stamped either', async () => {
      const result = await new BuilderService().build(
        makeContext(hookedExec(restoreUnmarked), { config: { ...withHook } })
      );
      expect(result.success).toBe(true);
      expect(await exists(markerPath())).toBe(false);
    });

    it('that restores a tree already stamped for THIS toolchain: it reads match, so the stamp stands', async () => {
      await seed(OLD);
      const result = await new BuilderService().build(
        makeContext(
          hookedExec(async () => {
            await restoreUnmarked();
            await fs.writeFile(markerPath(), ID);
          }),
          { config: { ...withHook } }
        )
      );
      expect(result.success).toBe(true);
      expect(await marker()).toBe(ID);
    });
  });

  it('a static source SPA whose hook makes it pre-built after the move: the install is skipped and the build COMMITS (the stale tree is not put back)', async () => {
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } })
    );
    await seed(OLD);
    const ran: string[] = [];
    const exec: ExecCommandFn = async (command) => {
      ran.push(command);
      if (command === 'make-dist') {
        await fs.mkdir(path.join(appDir, 'dist'));
        await fs.writeFile(path.join(appDir, 'dist', 'index.html'), '<html></html>');
      }
      return ok;
    };

    const result = await new BuilderService().build(
      makeContext(exec, { appType: 'spa', config: { preBuild: ['make-dist'] } })
    );

    expect(result.success).toBe(true);
    expect(ran).toEqual(['make-dist']); // no install, no build
    expect(await exists(modules())).toBe(false);
    expect(await asideGone()).toBe(true);
  });

  describe('a parked tree left by a crashed build', () => {
    it('is restored at the start of the next build, which then fails: the original is back', async () => {
      // The crash: the original exists only in its slot, node_modules is gone.
      await fs.mkdir(parkedDir(), { recursive: true });
      await fs.writeFile(path.join(parkedDir(), 'pkg.txt'), 'x');
      await fs.writeFile(path.join(parkedDir(), '.drop-toolchain'), OLD);
      const exec: ExecCommandFn = async (command) =>
        command === 'npm install' ? { ...ok, exitCode: 1, stderr: 'boom' } : ok;

      const result = await new BuilderService().build(makeContext(exec));

      expect(result.success).toBe(false);
      expect(await listing()).toEqual(restored);
      expect(await marker()).toBe(OLD);
      expect(await asideGone()).toBe(true);
    });

    it('is restored even when the next build would not touch node_modules (no JS install)', async () => {
      await fs.mkdir(parkedDir(), { recursive: true });
      await fs.writeFile(path.join(parkedDir(), 'pkg.txt'), 'x');
      const exec: ExecCommandFn = async (command) => {
        if (command === 'npm run build') await buildOutput();
        return ok;
      };

      const result = await new BuilderService().build(
        makeContext(exec, { config: { installCommand: 'make deps' } })
      );

      expect(result.success).toBe(true);
      expect(await listing()).toEqual(['pkg.txt']);
      expect(await asideGone()).toBe(true);
    });

    it('whose recovery fails stops the build before anything is moved, with a generic error', async () => {
      await fs.mkdir(parkedDir(), { recursive: true });
      await fs.writeFile(path.join(parkedDir(), 'pkg.txt'), 'x');
      jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error(`EBUSY: ${appDir}`), { code: 'EBUSY' }));
      const exec = jest.fn().mockResolvedValue(ok);

      const result = await new BuilderService().build(makeContext(exec));

      expect(result.success).toBe(false);
      expect(result.errors[0].stage).toBe('pre-build');
      expect(result.errors[0].message).toBe('could not restore node_modules parked by an earlier build');
      expect(result.errors[0].message).not.toContain(appDir);
      expect(exec).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(parkedDir(), 'pkg.txt'), 'utf-8')).toBe('x');
    });
  });

  it('runs the dependency step BEFORE drop.yaml preBuild hooks: a hook file in node_modules survives', async () => {
    await seed(OLD);
    const order: string[] = [];
    const exec: ExecCommandFn = async (command) => {
      order.push(command);
      if (command === 'seed-hook') {
        await fs.mkdir(modules(), { recursive: true });
        await fs.writeFile(path.join(modules(), 'hooked.txt'), 'h');
      }
      if (command === 'npm run build') await buildOutput();
      return ok;
    };

    const result = await new BuilderService().build(
      makeContext(exec, { config: { installCommand: 'npm install', preBuild: ['seed-hook'] } })
    );

    expect(result.success).toBe(true);
    expect(order.slice(0, 2)).toEqual(['seed-hook', 'npm install']);
    expect(await exists(path.join(modules(), 'hooked.txt'))).toBe(true);
    expect(await asideGone()).toBe(true);
  });
});
