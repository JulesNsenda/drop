/**
 * Tenant build commands must run inside the build container on BOTH build
 * paths, not just the fresh-deploy one.
 *
 * `install`, `build` and drop.yaml build hooks are tenant-authored strings.
 * Under docker isolation the builder is handed an `execCommand` that runs them
 * inside an ephemeral container (own user, CapDrop ALL, no docker socket).
 * With no `execCommand` the builder falls back to `executeCommand` — a plain
 * host `child_process` running as the platform user, who is in the `docker`
 * group on an isolation=docker box and therefore root-equivalent.
 *
 * `handleBuildApp` (fresh deploy) always passed one. `handleAppUpdate` — which
 * every upload-deploy and git redeploy of an EXISTING app goes through, i.e.
 * the common path — passed none.
 *
 * The same helper also returns the toolchain id the build installs
 * dependencies with (`toolchainId`) and the aside dir a stale node_modules waits
 * in (`nodeModulesAsideDir`), so both paths move aside/stamp node_modules against
 * the same id and the same place. The id comes from the one producer,
 * `toolchainIdFor`; the behavioural tests below drive BOTH build paths and compare
 * what reaches `builder.build`.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DropPlatform, createPlatform } from './platform';
import * as toolchain from './builder/toolchain';
import { selectBuildImage } from '../managers/runtime/container-config';

const SENTINEL = 'node-abi-999-sentinel-x64-glibc';

import { loadEmptySuspensionStore } from './__testutils__/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);

describe('build exec parity between the two build paths', () => {
  let tempDir: string;

  const makePlatform = (isolation: 'docker' | 'none'): DropPlatform => {
    const platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation,
    });
    // A docker-shaped runtime; `docker` is only ever handed to
    // createContainerExecCommand, which we never invoke here.
    (platform as any).runtime = { type: isolation === 'docker' ? 'docker' : 'pm2', docker: {} };
    return platform;
  };

  const toolchainFor = (platform: DropPlatform, appType = 'nodejs') =>
    (platform as any).buildToolchainFor(appType, 'my-app') as Promise<{
      execCommand: unknown;
      toolchainId: string | null;
      nodeModulesAsideDir: string;
    }>;
  const execFor = async (platform: DropPlatform) => (await toolchainFor(platform)).execCommand;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-exec-parity-${Date.now()}-${Math.random()}`);
  });

  describe('buildToolchainFor', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns a container exec runner under docker isolation', async () => {
      expect(typeof (await execFor(makePlatform('docker')))).toBe('function');
    });

    it('returns undefined under host isolation, where running on the host is the intent', async () => {
      jest.spyOn(toolchain, 'toolchainIdFor').mockResolvedValue(null);
      expect(await execFor(makePlatform('none'))).toBeUndefined();
    });

    // The next two pin FAIL-CLOSED. Returning undefined here would be the
    // dangerous answer: it silently converts "configured for docker isolation
    // but no container runtime" into "run this tenant's install/build command
    // unconfined on the host". Throwing fails the build loudly, leaves the
    // previously-deployed version serving, and shows the operator a config
    // error instead of an invisible sandbox bypass.
    it('THROWS rather than falling back to the host when the runtime is not the container manager', async () => {
      const platform = makePlatform('docker');
      (platform as any).runtime = { type: 'pm2' };
      await expect(execFor(platform)).rejects.toThrow(/no container runtime/i);
    });

    it('THROWS rather than falling back to the host when there is no runtime at all', async () => {
      const platform = makePlatform('docker');
      (platform as any).runtime = null;
      await expect(execFor(platform)).rejects.toThrow(/no container runtime/i);
    });

    describe('toolchainId', () => {
      afterEach(() => jest.restoreAllMocks());

      const probeCwd = (): string => path.join(tempDir, 'data', 'drop-svc', 'toolchain-probe');

      it('is the ABI id of the image the build container runs, under docker isolation', async () => {
        const { toolchainId } = await toolchainFor(makePlatform('docker'));
        expect(toolchainId).not.toBeNull();
        expect(toolchainId).toBe(toolchain.toolchainIdFromImage(selectBuildImage('nodejs')));
      });

      it('follows the BUILD image, not the runtime image (static/spa build on node)', async () => {
        const { toolchainId } = await toolchainFor(makePlatform('docker'), 'spa');
        expect(toolchainId).toBe(toolchain.toolchainIdFromImage(selectBuildImage('spa')));
        expect(toolchainId).toMatch(/^node-abi-/);
      });

      it.each(['docker', 'none'] as const)(
        'takes the id from toolchainIdFor(%s, appType, a platform-owned dir) and nowhere else',
        async (isolation) => {
          const produced = jest.spyOn(toolchain, 'toolchainIdFor').mockResolvedValue(SENTINEL);
          const { toolchainId } = await toolchainFor(makePlatform(isolation), 'spa');
          expect(toolchainId).toBe(SENTINEL);
          expect(produced).toHaveBeenCalledTimes(1);
          expect(produced).toHaveBeenCalledWith(isolation, 'spa', probeCwd());
        }
      );

      it('is null (unknown) when the producer says so', async () => {
        jest.spyOn(toolchain, 'toolchainIdFor').mockResolvedValue(null);
        expect((await toolchainFor(makePlatform('none'))).toolchainId).toBeNull();
      });

      it('probes in its own dir under data/drop-svc, created 0700 (never data/drop-svc itself)', async () => {
        jest.spyOn(toolchain, 'toolchainIdFor').mockResolvedValue(null);
        await toolchainFor(makePlatform('none'));
        const stat = fs.statSync(probeCwd());
        expect(stat.isDirectory()).toBe(true);
        expect(fs.readdirSync(probeCwd())).toEqual([]);
        if (process.platform !== 'win32') expect(stat.mode & 0o077).toBe(0);
      });
    });

    describe('nodeModulesAsideDir', () => {
      it.each(['docker', 'none'] as const)(
        'is data/temp/.node-modules-aside/<app> under %s, with only the parent created (0700)',
        async (isolation) => {
          jest.spyOn(toolchain, 'toolchainIdFor').mockResolvedValue(null);
          const { nodeModulesAsideDir } = await toolchainFor(makePlatform(isolation));
          const parent = path.join(tempDir, 'data', 'temp', '.node-modules-aside');
          expect(nodeModulesAsideDir).toBe(path.join(parent, 'my-app'));
          expect(fs.statSync(parent).isDirectory()).toBe(true);
          expect(fs.existsSync(nodeModulesAsideDir)).toBe(false);
          if (process.platform !== 'win32') expect(fs.statSync(parent).mode & 0o077).toBe(0);
        }
      );
    });
  });

  describe('stop and app removal', () => {
    afterEach(() => jest.restoreAllMocks());

    it('stop() drops the cached host probe', async () => {
      const platform = makePlatform('none');
      (platform as any).isRunning = true;
      const reset = jest.spyOn(toolchain, 'resetToolchainProbeCache');
      await platform.stop();
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it('purgeAppArtifacts sweeps the aside dir of that app, read-only subtrees included, and no other', async () => {
      const platform = makePlatform('none');
      const parent = path.join(tempDir, 'data', 'temp', '.node-modules-aside');
      const mine = path.join(parent, 'my-app', 'pkg', 'locked');
      const other = path.join(parent, 'other-app');
      fs.mkdirSync(mine, { recursive: true });
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(mine, 'f.txt'), 'x');
      fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
      if (process.platform !== 'win32') fs.chmodSync(mine, 0o500);

      await (platform as any).purgeAppArtifacts('my-app');

      expect(fs.existsSync(path.join(parent, 'my-app'))).toBe(false);
      expect(fs.existsSync(path.join(other, 'keep.txt'))).toBe(true);
    });
  });

  describe('the invariant is compiler-enforced, not test-enforced', () => {
    // BuildContext.execCommand is REQUIRED (typed as the fn OR undefined), so
    // any builder.build call that omits it is a compile error — at every call
    // site, in every module. That is what actually prevents this regression
    // recurring. An earlier version of this file grepped platform.ts for the
    // property instead; that caught the named bug, but would have passed
    // vacuously the moment a build path moved into another file.
    //
    // This test fails loudly if the property is ever made optional again,
    // since that silently removes the compiler guarantee.
    it('BuildContext declares execCommand as required', () => {
      const types = fs.readFileSync(
        path.join(__dirname, 'builder', 'builder.types.ts'),
        'utf-8'
      );
      expect(types).toContain('execCommand: ExecCommandFn | undefined;');
      expect(types).not.toContain('execCommand?:');
    });

    it('BuildContext declares toolchainId as required (nullable, never optional)', () => {
      const types = fs.readFileSync(
        path.join(__dirname, 'builder', 'builder.types.ts'),
        'utf-8'
      );
      expect(types).toContain('toolchainId: string | null;');
      expect(types).not.toContain('toolchainId?:');
    });

    it('BuildContext declares nodeModulesAsideDir as required (possibly undefined, never optional)', () => {
      const types = fs.readFileSync(
        path.join(__dirname, 'builder', 'builder.types.ts'),
        'utf-8'
      );
      expect(types).toContain('nodeModulesAsideDir: string | undefined;');
      expect(types).not.toContain('nodeModulesAsideDir?:');
    });
  });

  describe('the container check lives in one place', () => {
    it('createContainerExecCommand is invoked only inside the helper', () => {
      // A build path that re-implements the isolation check inline can drift
      // from this one — which is how handleAppUpdate ended up with no check.
      const source = fs.readFileSync(path.join(__dirname, 'platform.ts'), 'utf-8');
      // The import has no trailing paren, so only the invocation is counted.
      expect(source.split('createContainerExecCommand(').length - 1).toBe(1);
    });
  });

  describe('both build paths hand builder.build the id from toolchainIdFor', () => {
    afterEach(() => jest.restoreAllMocks());

    /**
     * Drive one build path as far as builder.build, with the producer stubbed to
     * a value that encodes its own arguments, and return what the builder got.
     */
    const driveBuild = async (
      path_: 'handleBuildApp' | 'handleAppUpdate',
      isolation: 'docker' | 'none',
      appType: string
    ): Promise<{ call: any; produced: jest.SpyInstance }> => {
      const platform = makePlatform(isolation);
      // A booted platform: the one-shot toolchain backfill has run.
      (platform as any).toolchainBackfilled = true;
      const appName = 'my-app';
      const appPath = path.join(tempDir, 'apps', appName);
      fs.mkdirSync(appPath, { recursive: true });

      const produced = jest
        .spyOn(toolchain, 'toolchainIdFor')
        .mockImplementation(async (iso, type) => `${SENTINEL}:${iso}:${type}`);
      const build = jest.fn().mockResolvedValue({
        success: false,
        duration: 1,
        errors: [{ message: 'stub' }],
      });
      (platform as any).detector = {
        detect: jest.fn().mockResolvedValue({ type: appType, framework: null, suggestedConfig: {} }),
      };
      (platform as any).builder = { build };
      (platform as any).buildLogService = null;
      (platform as any).appConfigService = { updateConfig: jest.fn().mockResolvedValue(undefined) };
      (platform as any).stateManager = {
        // A running app, so handleAppUpdate takes its hot-reload path; handleBuildApp
        // only reads it to tell a redeploy from a new app.
        getApp: jest.fn().mockReturnValue({ name: appName, status: 'running', port: 3005 }),
        setAppStatus: jest.fn().mockResolvedValue(undefined),
        updateApp: jest.fn().mockResolvedValue(undefined),
      };

      if (path_ === 'handleBuildApp') {
        await (platform as any).handleBuildApp(appPath, appName, appType);
      } else {
        await (platform as any).handleAppUpdate(appName, appPath, 'edit', true);
      }
      (platform as any).appsInProgress.clear();

      expect(build).toHaveBeenCalledTimes(1);
      return { call: build.mock.calls[0][0], produced };
    };

    it.each([
      ['handleBuildApp', 'docker'],
      ['handleBuildApp', 'none'],
      ['handleAppUpdate', 'docker'],
      ['handleAppUpdate', 'none'],
    ] as const)('%s under %s isolation', async (path_, isolation) => {
      const { call, produced } = await driveBuild(path_, isolation, 'nextjs');
      expect(call.toolchainId).toBe(`${SENTINEL}:${isolation}:nextjs`);
      expect(call.nodeModulesAsideDir).toBe(
        path.join(tempDir, 'data', 'temp', '.node-modules-aside', 'my-app')
      );
      expect(produced).toHaveBeenCalledTimes(1);
      expect(produced).toHaveBeenCalledWith(
        isolation,
        'nextjs',
        path.join(tempDir, 'data', 'drop-svc', 'toolchain-probe')
      );
      // Execution parity: a container runner under docker, the host otherwise.
      expect(typeof call.execCommand).toBe(isolation === 'docker' ? 'function' : 'undefined');
    });

    it.each(['handleBuildApp', 'handleAppUpdate'] as const)(
      '%s hands the builder the real producer id under docker, and the aside dir',
      async (path_) => {
        // No stub: toolchainIdFor and selectBuildImage run for real, so this
        // fails if either build path stops going through the one helper.
        const platform = makePlatform('docker');
        (platform as any).toolchainBackfilled = true;
        // Its own app name: the deploy circuit breaker is process-wide and keyed by
        // app, and the stubbed builds above have already tripped 'my-app'.
        const appName = `real-producer-${path_}`.toLowerCase();
        const appPath = path.join(tempDir, 'apps', appName);
        fs.mkdirSync(appPath, { recursive: true });
        const build = jest.fn().mockResolvedValue({
          success: false,
          duration: 1,
          errors: [{ message: 'stub' }],
        });
        (platform as any).detector = {
          detect: jest
            .fn()
            .mockResolvedValue({ type: 'nextjs', framework: null, suggestedConfig: {} }),
        };
        (platform as any).builder = { build };
        (platform as any).buildLogService = null;
        (platform as any).appConfigService = { updateConfig: jest.fn().mockResolvedValue(undefined) };
        (platform as any).stateManager = {
          getApp: jest.fn().mockReturnValue({ name: appName, status: 'running', port: 3005 }),
          setAppStatus: jest.fn().mockResolvedValue(undefined),
          updateApp: jest.fn().mockResolvedValue(undefined),
        };

        if (path_ === 'handleBuildApp') {
          await (platform as any).handleBuildApp(appPath, appName, 'nextjs');
        } else {
          await (platform as any).handleAppUpdate(appName, appPath, 'edit', true);
        }
        (platform as any).appsInProgress.clear();

        const direct = await toolchain.toolchainIdFor(
          'docker',
          'nextjs',
          path.join(tempDir, 'data', 'drop-svc', 'toolchain-probe')
        );
        expect(direct).not.toBeNull();
        const call = build.mock.calls[0][0];
        expect(call.toolchainId).toBe(direct);
        expect(call.toolchainId).toBe(toolchain.toolchainIdFromImage(selectBuildImage('nextjs')));
        expect(call.nodeModulesAsideDir).toBe(
          path.join(tempDir, 'data', 'temp', '.node-modules-aside', appName)
        );
        expect(typeof call.execCommand).toBe('function');
      }
    );
  });
});
