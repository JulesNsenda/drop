/**
 * Promotion gate (Step 6d).
 *
 * The invariant: under manual promotion, unapproved code NEVER serves — on the
 * first deploy and on every redeploy. SEC-9 found the withhold-the-route design
 * gated only the first, because on a redeploy the route already existed and the
 * new process took the same port.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import {
  promotionModeFor,
  defaultPromotionMode,
  shouldHoldForPromotion,
} from '../managers/guardrail/promotion';

describe('promotion mode resolution', () => {
  const saved = process.env.DROP_DEFAULT_PROMOTION;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_DEFAULT_PROMOTION;
    else process.env.DROP_DEFAULT_PROMOTION = saved;
  });

  it('defaults to auto, so existing installs are unchanged', () => {
    delete process.env.DROP_DEFAULT_PROMOTION;
    expect(defaultPromotionMode()).toBe('auto');
    expect(promotionModeFor(undefined)).toBe('auto');
  });

  it('follows the platform default when an app says nothing', () => {
    process.env.DROP_DEFAULT_PROMOTION = 'manual';
    expect(promotionModeFor(undefined)).toBe('manual');
  });

  it('lets a per-app AUTO override a manual platform', () => {
    // An operator who marked one app auto meant it — otherwise the per-app
    // setting would be write-only in exactly the direction people need.
    process.env.DROP_DEFAULT_PROMOTION = 'manual';
    expect(promotionModeFor('auto')).toBe('auto');
  });

  it('lets a per-app MANUAL override an auto platform', () => {
    delete process.env.DROP_DEFAULT_PROMOTION;
    expect(promotionModeFor('manual')).toBe('manual');
  });

  it('treats an unrecognised value as unset rather than as manual', () => {
    // Failing to `manual` on a typo would silently stop every deploy on the box
    // from going live, which reads as a total outage.
    process.env.DROP_DEFAULT_PROMOTION = 'sometimes';
    expect(defaultPromotionMode()).toBe('auto');
    expect(promotionModeFor('yes' as never)).toBe('auto');
  });

  it('holds only in manual', () => {
    expect(shouldHoldForPromotion('manual')).toBe(true);
    expect(shouldHoldForPromotion('auto')).toBe(false);
  });
});

describe('holdForPromotion', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let updateConfig: jest.Mock;
  let updateApp: jest.Mock;
  let getConfig: jest.Mock;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-promote-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    updateConfig = jest.fn().mockResolvedValue(undefined);
    updateApp = jest.fn().mockResolvedValue(undefined);
    getConfig = jest.fn().mockReturnValue({ promotion: 'manual' });
    (platform as any).appConfigService = { getConfig, updateConfig };
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue({ name: 'app', status: 'running', userId: 'u1' }),
      updateApp,
    };
  });

  afterEach(async () => {
    delete process.env.DROP_DEFAULT_PROMOTION;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('holds under manual and records what was built', async () => {
    const held = await (platform as any).holdForPromotion('app', '/out', 'deploy-1');

    expect(held).toBe(true);
    expect(updateConfig).toHaveBeenCalledWith(
      'app',
      expect.objectContaining({
        pendingPromotion: expect.objectContaining({ deployId: 'deploy-1', outputDirectory: '/out' }),
      })
    );
  });

  it('does not hold under auto', async () => {
    getConfig.mockReturnValue({ promotion: 'auto' });

    expect(await (platform as any).holdForPromotion('app', '/out')).toBe(false);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('leaves the app STATUS alone, so it keeps describing what is running', async () => {
    // A running app is still running — its old version is serving, untouched.
    // Overwriting status would make the platform lie about what is live, and
    // ~20 `status === 'running'` comparisons answer questions that would then
    // get the wrong answer.
    await (platform as any).holdForPromotion('app', '/out');

    expect(updateApp).toHaveBeenCalledWith('app', { awaitingPromotion: true });
    const statusWrites = updateApp.mock.calls.filter((c) => 'status' in (c[1] ?? {}));
    expect(statusWrites).toHaveLength(0);
  });

  it('does not depend on WHO deployed', async () => {
    // The gate is an operator's standing decision about an app, not a judgement
    // about the caller. If it were caller-dependent, a human's own deploy would
    // silently skip the gate they set — and an agent would have a shape to
    // imitate.
    const held = await (platform as any).holdForPromotion('app', '/out');
    expect(held).toBe(true);
  });
});

describe('promoteApp', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let handleStartApp: jest.SpyInstance;
  let updateConfig: jest.Mock;
  let getConfig: jest.Mock;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-promote2-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    updateConfig = jest.fn().mockResolvedValue(undefined);
    getConfig = jest.fn().mockReturnValue({
      promotion: 'manual',
      pendingPromotion: { builtAt: '2026-07-27T00:00:00.000Z', outputDirectory: '/built' },
    });
    (platform as any).appConfigService = { getConfig, updateConfig };
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue({ name: 'app', status: 'running', userId: 'u1' }),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    handleStartApp = jest
      .spyOn(platform as any, 'handleStartApp')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('starts exactly what was built, not a fresh build', async () => {
    // A rebuild could pick up source that changed since the operator looked,
    // promoting something nobody approved.
    await platform.promoteApp('app');

    expect(handleStartApp).toHaveBeenCalledWith('app', '/built');
  });

  it('clears the hold so a later deploy is not confused with this one', async () => {
    await platform.promoteApp('app');

    expect(updateConfig).toHaveBeenCalledWith('app', { pendingPromotion: undefined });
  });

  it('refuses when nothing is held', async () => {
    getConfig.mockReturnValue({ promotion: 'manual' });

    await expect(platform.promoteApp('app')).rejects.toThrow(/awaiting promotion/);
    expect(handleStartApp).not.toHaveBeenCalled();
  });

  it('releases the in-progress guard even when the start throws', async () => {
    // Otherwise a failed promotion wedges the app out of every future deploy.
    handleStartApp.mockRejectedValue(new Error('start failed'));

    await expect(platform.promoteApp('app')).rejects.toThrow('start failed');
    expect((platform as any).appsInProgress.has('app')).toBe(false);
  });
});

describe('the redeploy path holds BEFORE the stop', () => {
  // The branch SEC-9 found broken. Withholding the Caddy route only ever gated
  // a FIRST deploy: on a redeploy the route already exists and the new process
  // takes the same port, so unapproved code was live the instant it started.
  // Holding before the stop leaves the approved version running and serving.
  //
  // Wired by hand rather than via platform.start(): start() boots the bundled
  // Postgres, which hangs on a dev box without it.
  let platform: DropPlatform;
  let tempDir: string;
  let appPath: string;
  let stop: jest.Mock;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-promote3-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', 'live');
    await fs.mkdir(appPath, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    stop = jest.fn().mockResolvedValue(undefined);
    (platform as any).runtime = {
      stop,
      start: jest.fn().mockResolvedValue({ pid: 1 }),
      getStatus: jest.fn().mockResolvedValue({ status: 'running', restarts: 0 }),
      type: 'pm2',
    };
    (platform as any).detector = {
      detect: jest.fn().mockResolvedValue({ type: 'nodejs', framework: null, suggestedConfig: {} }),
    };
    (platform as any).builder = {
      build: jest.fn().mockResolvedValue({ success: true, duration: 5, outputPath: '/out' }),
    };
    (platform as any).appConfigService = {
      getConfig: jest.fn().mockReturnValue({ promotion: 'manual' }),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue({
        name: 'live',
        path: appPath,
        type: 'nodejs',
        status: 'running',
        port: 4321,
        userId: 'u1',
      }),
      updateApp: jest.fn().mockResolvedValue(undefined),
      setAppStatus: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).buildLogService = null;
    jest.spyOn(platform as any, 'resolveBuildEnv').mockResolvedValue({});
    jest.spyOn(platform as any, 'getBuildWorkDir').mockResolvedValue(appPath);
    jest.spyOn(platform as any, 'recordDeploySignature').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    (platform as any).appsInProgress.clear();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('does NOT stop the running version when the build is held', async () => {
    jest.spyOn(platform as any, 'holdForPromotion').mockResolvedValue(true);

    await (platform as any).handleAppUpdate('live', appPath, 'upload deploy', true, {});

    expect(stop).not.toHaveBeenCalled();
  });

  it('DOES swap when the build is not held', async () => {
    // The other half: without this the first assertion would pass even if the
    // redeploy path had stopped doing anything at all.
    jest.spyOn(platform as any, 'holdForPromotion').mockResolvedValue(false);

    await (platform as any).handleAppUpdate('live', appPath, 'upload deploy', true, {});

    expect(stop).toHaveBeenCalledWith('live');
  });
});
