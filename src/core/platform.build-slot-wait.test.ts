/**
 * The incident path: a boot-reconcile burst redeploys several apps at once and
 * the builder's concurrent-build cap used to REFUSE the excess (MAX_BUILDS), which
 * handleAppUpdate treated as a failed build — the app was left with its source
 * re-synced and no rebuild, serving 500. A cap-full build now WAITS for a slot,
 * so a redeploy can no longer be refused or lost.
 *
 * Drives handleAppUpdate with reason 'monorepo re-expansion' and bypassCooldown
 * true (what expandMonorepo sends for an existing child) against the REAL
 * BuilderService at cap 1, with a gated strategy occupying the only slot. The
 * expandMonorepo wrapper itself is not used: its file-sync half is covered by
 * platform.monorepo-materialization.test.ts and adds nothing to the build wait.
 * The post-build swap (stop/start, router, signatures) is stubbed at the
 * platform's own private seams.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
// Stub the free-disk preflight: it shells out to the OS, which would couple this
// suite to the runner's real free disk. The rest of the module stays real.
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform } from './platform';
import { loadEmptySuspensionStore } from './__testutils__/suspension';
import { getSuspensionStore } from '../managers/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);
import { BuilderService } from './builder';
import { BuildContext, BuildStrategy } from './builder/builder.types';

describe('redeploy of a running app while the builder is at its cap', () => {
  let tempDir: string;
  let platform: DropPlatform;
  let release: Map<string, () => void>;
  let buildsRun: string[];
  let setAppStatus: jest.Mock;
  let runtimeStart: jest.Mock;
  let startBuildLog: jest.Mock;
  let appState: { name: string; status: string; port: number };
  const appName = `slot-wait-app-${Date.now()}`;

  const p = () => platform as any;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const ctx = (name: string): BuildContext => ({
    appName: name,
    appPath: tempDir,
    appType: 'rust',
    framework: null,
    config: {},
    env: {},
    execCommand: undefined,
    toolchainId: null,
    nodeModulesAsideDir: undefined,
  });

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-build-slot-wait-${Date.now()}-${Math.random()}`);
    const appPath = path.join(tempDir, 'apps', appName);
    fs.mkdirSync(appPath, { recursive: true });
    release = new Map();
    buildsRun = [];

    // 'rust' has no built-in strategy, so this gated one is the only match.
    const builder = new BuilderService({ maxConcurrentBuilds: 1 });
    builder.registerStrategy({
      name: 'gated',
      supportedTypes: ['rust'],
      canBuild: () => true,
      getInstallCommand: () => null,
      getBuildCommand: () => null,
      getOutputDirectory: () => null,
      preBuild: async (context: BuildContext) => {
        buildsRun.push(context.appName);
        // Only the occupant is held; the redeploy under test runs straight through.
        if (context.appName === 'occupant') {
          await new Promise<void>((resolve) => release.set('occupant', resolve));
        }
      },
    } as BuildStrategy);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    appState = { name: appName, status: 'running', port: 3005 };
    setAppStatus = jest.fn().mockResolvedValue(undefined);
    runtimeStart = jest.fn().mockResolvedValue({ pid: 4242 });
    p().runtime = { type: 'pm2', stop: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined), getStatus: jest.fn().mockResolvedValue(null), start: runtimeStart };
    p().toolchainBackfilled = true;
    p().builder = builder;
    p().detector = {
      detect: jest.fn().mockResolvedValue({ type: 'rust', framework: null, suggestedConfig: {} }),
    };
    startBuildLog = jest.fn().mockResolvedValue('log-1');
    p().buildLogService = {
      startBuild: startBuildLog,
      writeLine: jest.fn(),
      finishBuild: jest.fn().mockResolvedValue(undefined),
    };
    p().appConfigService = {
      updateConfig: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };
    p().stateManager = {
      getApp: jest.fn(() => appState),
      setAppStatus,
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(p(), 'holdForPromotion').mockResolvedValue(false);
    jest.spyOn(p(), 'tryCutover').mockResolvedValue(false);
    jest.spyOn(p(), 'buildFreshStartSpec').mockResolvedValue({ spec: { name: appName }, port: 3005 });
    jest.spyOn(p(), 'noteRuntimeLogStart').mockResolvedValue(undefined);
    jest.spyOn(p(), 'recordDeploySignature').mockResolvedValue(undefined);
    jest.spyOn(p(), 'commitServedPath').mockResolvedValue(undefined);
    jest.spyOn(p(), 'armPostDeployWatches').mockImplementation(() => undefined);
    jest.spyOn(p(), 'stopHealthProber').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (platform.isActive()) await platform.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Park a redeploy behind a build holding the only slot; returns both promises. */
  async function redeployBehindOccupant(): Promise<{ occupant: Promise<unknown>; redeploy: Promise<void> }> {
    const appPath = path.join(tempDir, 'apps', appName);
    const occupant = (p().builder as BuilderService).build(ctx('occupant'));
    await tick();
    expect(buildsRun).toEqual(['occupant']);

    const redeploy = p().handleAppUpdate(appName, appPath, 'monorepo re-expansion', true);
    // handleAppUpdate awaits file reads before it reaches the builder.
    for (let i = 0; i < 500 && !(p().builder as any).waitingApps.has(appName); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((p().builder as any).waitingApps.has(appName)).toBe(true);
    return { occupant, redeploy };
  }

  it('waits for the slot WITHOUT touching status, then builds and restarts the app', async () => {
    const outcome = jest.spyOn(p(), 'recordDeployOutcome');
    const prepare = jest.spyOn(p(), 'prepareDeployTarget');

    const { occupant, redeploy } = await redeployBehindOccupant();

    // Waiting: the old version is untouched and nothing was set up.
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(p().deployTargets.has(appName)).toBe(false);
    expect(startBuildLog).not.toHaveBeenCalled();
    expect(buildsRun).toEqual(['occupant']);
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(p().appsInProgress.has(appName)).toBe(true);

    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant', appName]);
    expect(setAppStatus).toHaveBeenNthCalledWith(1, appName, 'building');
    expect(runtimeStart).toHaveBeenCalledTimes(1);
    expect(setAppStatus).toHaveBeenLastCalledWith(appName, 'running', { port: 3005, pid: 4242 });
    for (const [, status, details] of setAppStatus.mock.calls) {
      expect(status).not.toBe('errored');
      expect(details?.error ?? '').not.toMatch(/Build failed/);
    }
    expect(outcome).toHaveBeenCalledWith(appName, true);
    expect(outcome).not.toHaveBeenCalledWith(appName, false);
    expect(p().appsInProgress.has(appName)).toBe(false);
  });

  /** After an aborted redeploy the slot must be free: a reservation resolves at once. */
  async function expectSlotFree(): Promise<void> {
    const got = await Promise.race([
      (p().builder as BuilderService).reserveSlot('later').then((r) => (r(), true)),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(got).toBe(true);
  }

  it('defers with no side effects when a backup quiesce begins during the wait', async () => {
    const outcome = jest.spyOn(p(), 'recordDeployOutcome');
    const { occupant, redeploy } = await redeployBehindOccupant();

    jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(startBuildLog).not.toHaveBeenCalled();
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
    expect(appState.status).toBe('running');
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('aborts, still stopped and not restarted, when the user stops the app during the wait', async () => {
    const { occupant, redeploy } = await redeployBehindOccupant();

    appState.status = 'stopped';
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(appState.status).toBe('stopped');
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('aborts, nothing built or started, when an administrator suspends the app during the wait', async () => {
    const outcome = jest.spyOn(p(), 'recordDeployOutcome');
    const { occupant, redeploy } = await redeployBehindOccupant();

    await getSuspensionStore().suspend(appName, 'admin-1');
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(startBuildLog).not.toHaveBeenCalled();
    expect(runtimeStart).not.toHaveBeenCalled();
    // Uncharged: a refusal is not evidence the caller is looping.
    expect(outcome).not.toHaveBeenCalled();
    expect(appState.status).toBe('running');
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('aborts when the app is removed during the wait', async () => {
    const { occupant, redeploy } = await redeployBehindOccupant();

    appState = undefined as never;
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(p().appsInProgress.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('frees the slot after the build so the next waiter is not held through the restart', async () => {
    const { occupant, redeploy } = await redeployBehindOccupant();
    // The restart stalls; the slot must already be free while it does.
    let finishStart!: () => void;
    runtimeStart.mockImplementation(
      () => new Promise((resolve) => (finishStart = () => resolve({ pid: 1 })))
    );

    release.get('occupant')!();
    await occupant;
    for (let i = 0; i < 500 && !runtimeStart.mock.calls.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtimeStart).toHaveBeenCalled();
    await expectSlotFree();

    finishStart();
    await redeploy;
  });

  it('does not rebuild or restart an app that entered errored and was stopped during the wait', async () => {
    appState.status = 'errored';
    const { occupant, redeploy } = await redeployBehindOccupant();

    appState.status = 'stopped';
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(runtimeStart).not.toHaveBeenCalled();
    expect(p().appsInProgress.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('drops the redeploy when a git pull begins during the wait', async () => {
    const isCloning = jest.fn().mockReturnValue(false);
    p().gitDeployService = { isCloning };
    const { occupant, redeploy } = await redeployBehindOccupant();

    isCloning.mockReturnValue(true);
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).not.toHaveBeenCalled();
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
    await expectSlotFree();
  });

  it('leaves the slot free and appsInProgress cleared when a seam after the wait throws', async () => {
    const { occupant, redeploy } = await redeployBehindOccupant();

    (p().detector.detect as jest.Mock).mockRejectedValue(new Error('detect blew up'));
    release.get('occupant')!();
    await occupant;
    await redeploy;

    expect(buildsRun).toEqual(['occupant']);
    expect(setAppStatus).toHaveBeenLastCalledWith(appName, 'errored', {
      error: 'detect blew up',
    });
    expect(p().appsInProgress.has(appName)).toBe(false);
    await expectSlotFree();
  });
});
