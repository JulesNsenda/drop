/**
 * handleAppUpdate's admission races and failure bookkeeping, driven against the
 * REAL BuilderService and a real DeployTracker with the post-build swap stubbed
 * at the platform's private seams (same harness shape as
 * platform.build-slot-wait.test.ts).
 *
 *  - two concurrent updates of one app must not both be admitted: the early
 *    in-progress skip is stale after handleAppUpdate's own awaits;
 *  - a failed first deploy keeps its appsInProgress guard through its own
 *    cleanup tail, so an update arriving mid-tail is skipped, not admitted;
 *  - a throw before builder.build() must close a failed episode.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform } from './platform';
import { BuilderService } from './builder';
import { BuildContext, BuildStrategy } from './builder/builder.types';
import { eventBus } from './event-bus';
import { getDeployTracker, resetDeployTracker } from '../managers/deploy-tracker';
import { getDeployBreaker, resetDeployBreaker } from '../managers/guardrail/deploy-breaker';

interface TestAppState {
  name: string;
  status: string;
  port: number;
  error?: string;
}

describe('handleAppUpdate admission and failure bookkeeping', () => {
  let tempDir: string;
  let appPath: string;
  let platform: DropPlatform;
  let gateArmed: boolean;
  let failNextBuild: boolean;
  let releaseGate: (() => void) | undefined;
  let markGateHit: () => void;
  let gateHit: Promise<void>;
  let buildsRun: string[];
  let setAppStatus: jest.Mock;
  let startBuildLog: jest.Mock;
  let appState: TestAppState;
  let unsub: () => void;
  const appName = `admission-app-${Date.now()}`;

  const p = () => platform as any;
  const watcherKey = () => p().guardrailKeys(appName, false, {})[0].key as string;
  const webhookKey = () =>
    p().guardrailKeys(appName, false, { automationSource: 'webhook' })[0].key as string;
  const failures = (key: string) => getDeployBreaker().peek(key).failures;

  beforeEach(async () => {
    resetDeployBreaker();
    resetDeployTracker();
    tempDir = path.join(os.tmpdir(), `drop-update-admission-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', appName);
    fs.mkdirSync(appPath, { recursive: true });
    buildsRun = [];
    gateArmed = false;
    failNextBuild = false;
    releaseGate = undefined;
    gateHit = new Promise<void>((resolve) => (markGateHit = resolve));

    const tracker = getDeployTracker(path.join(tempDir, 'deploys.json'));
    await tracker.initialize();
    unsub = tracker.subscribe(eventBus);

    // 'rust' has no built-in strategy, so this one is the only match. Once a
    // test arms the gate, the build parks inside the strategy until released.
    const realBuilder = new BuilderService({ maxConcurrentBuilds: 4 });
    realBuilder.registerStrategy({
      name: 'gated',
      supportedTypes: ['rust'],
      canBuild: () => true,
      getInstallCommand: () => null,
      getBuildCommand: () => null,
      getOutputDirectory: () => null,
      preBuild: async (context: BuildContext) => {
        buildsRun.push(context.appName);
        markGateHit();
        if (failNextBuild) throw new Error('stage failed');
        if (!gateArmed) return;
        await new Promise<void>((resolve) => (releaseGate = resolve));
      },
    } as BuildStrategy);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    appState = { name: appName, status: 'running', port: 3005 };
    // Replaces appState rather than mutating it, as a state manager handing out
    // copies would: a restore must not depend on the record it was given.
    setAppStatus = jest
      .fn()
      .mockImplementation(async (_n: string, status: string, details?: Record<string, unknown>) => {
        appState = { name: appName, port: appState.port, status, ...details } as TestAppState;
      });
    p().runtime = {
      type: 'pm2',
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue({ pid: 4242 }),
    };
    p().toolchainBackfilled = true;
    p().builder = realBuilder;
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
    jest.spyOn(p(), 'buildFreshStartSpec').mockResolvedValue({ spec: {}, port: 3005 });
    jest.spyOn(p(), 'noteRuntimeLogStart').mockResolvedValue(undefined);
    jest.spyOn(p(), 'recordDeploySignature').mockResolvedValue(undefined);
    jest.spyOn(p(), 'commitServedPath').mockResolvedValue(undefined);
    jest.spyOn(p(), 'armPostDeployWatches').mockImplementation(() => undefined);
    jest.spyOn(p(), 'stopHealthProber').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    unsub();
    await getDeployTracker().flush();
    resetDeployTracker();
    resetDeployBreaker();
    if (platform.isActive()) await platform.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('two concurrent explicit updates of one app', () => {
    it('admits exactly one on the ordinary rebuild path; the other is skipped as in progress', async () => {
      gateArmed = true;
      const outcome = jest.spyOn(p(), 'recordDeployOutcome');

      const first = p().handleAppUpdate(appName, appPath, 'api', true);
      const second = p().handleAppUpdate(appName, appPath, 'api', true);

      // Which of the two wins the race to the admit is up to file IO; the loser
      // is the one that settles while the winner is parked in the strategy.
      expect(await Promise.race([first, second])).toBe(false);
      // Fails fast if both ended without a build ever starting.
      await Promise.race([
        gateHit,
        Promise.all([first, second]).then(() => {
          throw new Error('both updates ended before a build started');
        }),
      ]);
      releaseGate!();
      expect((await Promise.all([first, second])).sort()).toEqual([false, true]);

      expect(buildsRun).toEqual([appName]);
      expect(startBuildLog).toHaveBeenCalledTimes(1);
      expect(setAppStatus.mock.calls.filter(([, s]) => s === 'building')).toHaveLength(1);
      expect(outcome).toHaveBeenCalledTimes(1);
      expect(outcome).toHaveBeenCalledWith(appName, true);
      expect(failures(watcherKey())).toBe(0);
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    describe('on the monorepo container branch', () => {
      let expand: jest.SpyInstance;
      let finish: () => void;
      let expandEntered: Promise<void>;

      beforeEach(() => {
        fs.mkdirSync(path.join(appPath, 'web'));
        fs.writeFileSync(path.join(appPath, 'drop.yaml'), 'services:\n  web:\n    path: web\n');
        let markEntered!: () => void;
        expandEntered = new Promise<void>((resolve) => (markEntered = resolve));
        expand = jest.spyOn(p(), 'expandMonorepo').mockImplementation(() => {
          markEntered();
          return new Promise<void>((resolve) => (finish = resolve));
        });
      });

      it('admits exactly one', async () => {
        const outcome = jest.spyOn(p(), 'recordDeployOutcome');

        const first = p().handleAppUpdate(appName, appPath, 'git redeploy', true);
        const second = p().handleAppUpdate(appName, appPath, 'git redeploy', true);

        // Whichever is admitted parks in the expansion; the other settles at once.
        expect(await Promise.race([first, second])).toBe(false);
        await expandEntered;
        expect(p().appsInProgress.has(appName)).toBe(true);
        finish();
        expect(await Promise.all([first, second])).toEqual([false, false]);

        expect(expand).toHaveBeenCalledTimes(1);
        expect(outcome).toHaveBeenCalledTimes(1);
        expect(outcome).toHaveBeenCalledWith(appName, true);
        expect(failures(watcherKey())).toBe(0);
        expect(p().breakerKeys.has(appName)).toBe(false);
        expect(p().appsInProgress.has(appName)).toBe(false);
      });

      // The three early skips are stale after the drop.yaml read; each is
      // re-checked before anything is reserved.
      it.each([
        ['a backup quiesce', () => jest.spyOn(p(), 'isQuiesced').mockReturnValueOnce(false).mockReturnValue(true)],
        [
          'a git pull',
          () => {
            p().gitDeployService = { isCloning: jest.fn().mockReturnValueOnce(false).mockReturnValue(true) };
          },
        ],
        [
          'an upload',
          () => {
            p().uploadDeployService = {
              isUploading: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
            };
          },
        ],
      ])('drops, reserving nothing, when %s begins during the read', async (_label, arrange) => {
        arrange();

        expect(await p().handleAppUpdate(appName, appPath, 'git redeploy', true)).toBe(false);

        expect(expand).not.toHaveBeenCalled();
        expect(p().breakerKeys.has(appName)).toBe(false);
        expect(p().appsInProgress.has(appName)).toBe(false);
        expect(failures(watcherKey())).toBe(0);
        expect(getDeployTracker().getEpisodes(appName)).toHaveLength(0);
      });
    });
  });

  it('keeps a failed first deploy in progress through its own cleanup tail', async () => {
    failNextBuild = true;
    // buildSub is the subscriber under test; a platform that was not start()ed
    // has not wired it.
    p().setupEventHandlers();
    let update: Promise<boolean> | undefined;
    let inProgressAtTail: boolean | undefined;
    // The tail of handleBuildApp marks the app errored; an update arriving at
    // exactly that point must find the deploy still in progress.
    setAppStatus.mockImplementation(async (_n: string, status: string, details?: Record<string, unknown>) => {
      appState = { name: appName, port: appState.port, status, ...details } as TestAppState;
      if (status === 'errored' && update === undefined) {
        inProgressAtTail = p().appsInProgress.has(appName);
        update = p().handleAppUpdate(appName, appPath, 'files changed');
      }
    });
    const outcome = jest.spyOn(p(), 'recordDeployOutcome');

    try {
      await p().handleBuildApp(appPath, appName, 'rust');
    } finally {
      for (const off of p().subscriptions.splice(0)) off();
    }

    expect(inProgressAtTail).toBe(true);
    expect(await update).toBe(false);
    // Only the failed deploy ever opened a build log, marked the app building or
    // reached the builder.
    expect(startBuildLog).toHaveBeenCalledTimes(1);
    expect(buildsRun).toEqual([appName]);
    expect(setAppStatus.mock.calls.filter(([, s]) => s === 'building')).toHaveLength(1);
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith(appName, false);
    expect(p().appsInProgress.has(appName)).toBe(false);
  });

  it('closes a failed episode and records one breaker failure when a step before builder.build() throws', async () => {
    p().detector.detect.mockRejectedValue(new Error('detect exploded'));

    expect(await p().handleAppUpdate(appName, appPath, 'api', true)).toBe(false);

    const [episode] = getDeployTracker().getEpisodes(appName);
    expect(episode).toBeDefined();
    expect(episode.status).toBe('failed');
    expect(failures(watcherKey())).toBe(1);
    expect(appState.status).toBe('errored');
    expect(p().breakerKeys.has(appName)).toBe(false);
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(buildsRun).toEqual([]);
  });

  it('does not close a second episode for a failure after builder.build() was entered', async () => {
    jest.spyOn(p(), 'buildFreshStartSpec').mockRejectedValue(new Error('start spec exploded'));
    const fail = jest.spyOn(p(), 'failDeployEpisode');

    expect(await p().handleAppUpdate(appName, appPath, 'api', true)).toBe(false);

    expect(fail).not.toHaveBeenCalled();
    expect(failures(watcherKey())).toBe(1);
  });

  describe('happy path is unchanged', () => {
    const statuses = () => setAppStatus.mock.calls.map(([, s]) => s);

    it('for an anonymous watcher-shaped update', async () => {
      const outcome = jest.spyOn(p(), 'recordDeployOutcome');

      expect(await p().handleAppUpdate(appName, appPath, 'files changed')).toBe(true);

      expect(statuses()).toEqual(['building', 'starting', 'running']);
      expect(setAppStatus).toHaveBeenLastCalledWith(appName, 'running', { port: 3005, pid: 4242 });
      expect(outcome).toHaveBeenCalledTimes(1);
      expect(outcome).toHaveBeenCalledWith(appName, true);
      expect(failures(watcherKey())).toBe(0);
      const episodes = getDeployTracker().getEpisodes(appName);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].status).not.toBe('failed');
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('for a webhook-shaped update', async () => {
      const outcome = jest.spyOn(p(), 'recordDeployOutcome');

      expect(
        await p().handleAppUpdate(appName, appPath, 'webhook', true, { automationSource: 'webhook' })
      ).toBe(true);

      expect(statuses()).toEqual(['building', 'starting', 'running']);
      expect(outcome).toHaveBeenCalledTimes(1);
      expect(outcome).toHaveBeenCalledWith(appName, true);
      expect(failures(webhookKey())).toBe(0);
      const episodes = getDeployTracker().getEpisodes(appName);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].status).not.toBe('failed');
      expect(p().appsInProgress.has(appName)).toBe(false);
    });
  });
});
