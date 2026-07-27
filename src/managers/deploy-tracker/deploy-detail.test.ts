/**
 * DeployDetailStore — the per-deploy diagnostic record.
 *
 * Step 2c. The store exists so that one bus subscriber covers all three start
 * paths; the alternative the plan rejected was ~6 write sites duplicated
 * inside platform error branches, which historically miss the redeploy path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventBus } from '../../core/event-bus';
import { DeployDetailStore } from './deploy-detail';

describe('DeployDetailStore', () => {
  let tmpDir: string;
  let storePath: string;
  let bus: EventBus;
  let store: DeployDetailStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploy-detail-test-'));
    storePath = path.join(tmpDir, 'deploy-details.json');
    bus = new EventBus();
    store = new DeployDetailStore(storePath);
    await store.initialize();
    store.subscribe(bus);
  });

  afterEach(async () => {
    await store.flush();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const openEpisode = (app: string, deployId = 'd1') =>
    bus.publish('build:started', { appId: app, buildId: 'b1', deployId });

  describe('build-phase failures', () => {
    it('records the stage, exit code and command from build:failed', async () => {
      openEpisode('app');
      bus.publish('build:failed', {
        appId: 'app',
        buildId: 'b1',
        error: new Error('npm ERR!'),
        stage: 'install',
        exitCode: 127,
        command: 'npm ci',
      });
      await store.flush();

      const detail = store.getDetail('d1');
      expect(detail).toMatchObject({
        deployId: 'd1',
        appName: 'app',
        phase: 'build',
        errorCode: 'INSTALL_FAILED',
        stage: 'install',
        exitCode: 127,
        command: 'npm ci',
      });
    });

    it('never stores the raw error message', async () => {
      // Same invariant as DeployRow — this record is persisted, and process
      // output carries absolute paths and env dumps.
      openEpisode('leaky');
      bus.publish('build:failed', {
        appId: 'leaky',
        buildId: 'b1',
        error: new Error('/etc/secret DATABASE_URL=postgres://u:pw@h/db'),
        stage: 'install',
      });
      await store.flush();

      const raw = JSON.stringify(store.getDetail('d1'));
      expect(raw).not.toContain('DATABASE_URL');
      expect(raw).not.toContain('/etc/secret');
    });
  });

  describe('boot-phase failures', () => {
    it('records a readiness failure against the open deploy', async () => {
      // deploy:failed carries no deployId — the store resolves it by app name
      // from the episode build:started opened, the same way DeployTracker does.
      openEpisode('booty', 'boot-1');
      bus.publish('deploy:failed', { appId: 'booty', phase: 'boot', reason: 'crash-looped' });
      await store.flush();

      expect(store.getDetail('boot-1')).toMatchObject({
        deployId: 'boot-1',
        appName: 'booty',
        phase: 'boot',
        errorCode: 'CRASH_LOOPED',
        reason: 'crash-looped',
      });
    });

    it('records exactly one detail across the real platform sequence', async () => {
      // The platform publishes deploy:failed and THEN writes 'errored', which
      // is also a close signal. Both reach this store; the outcome must be one
      // boot-phase record, not two and not a build-phase one overwriting it.
      openEpisode('seq', 'seq-1');
      bus.publish('deploy:failed', { appId: 'seq', phase: 'boot', reason: 'crash-looped' });
      bus.publish('app:updated', { appId: 'seq', changes: { status: 'errored' } });
      await store.flush();

      const all = store.getDetails('seq');
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ deployId: 'seq-1', phase: 'boot' });
    });
  });

  describe('runtime log offsets', () => {
    const offsets = {
      outFile: '/logs/app-2026-07-27-out.log',
      errFile: '/logs/app-2026-07-27-err.log',
      outStartOffset: 4096,
      errStartOffset: 128,
    };

    it('attaches the offsets captured before start to a boot failure', async () => {
      openEpisode('off', 'off-1');
      store.noteRuntimeLog('off', offsets);
      bus.publish('deploy:failed', { appId: 'off', phase: 'boot', reason: 'crash-looped' });
      await store.flush();

      expect(store.getDetail('off-1')?.runtimeLog).toEqual(offsets);
    });

    it('does NOT attach them to a build failure', async () => {
      // A build failure never reached runtime.start(), so any offsets on hand
      // belong to a PREVIOUS deploy. Attaching them would point a caller at
      // another deploy's output.
      openEpisode('stale', 'stale-1');
      store.noteRuntimeLog('stale', offsets);
      bus.publish('build:failed', {
        appId: 'stale',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'install',
      });
      await store.flush();

      expect(store.getDetail('stale-1')?.runtimeLog).toBeUndefined();
    });

    it('ignores offsets for an app with no open deploy', async () => {
      // restartApp reaches the same capture, but a restart is not a deploy and
      // opens no episode — there is nothing to key the offsets to.
      store.noteRuntimeLog('restarted', offsets);
      bus.publish('deploy:failed', {
        appId: 'restarted',
        phase: 'boot',
        reason: 'crash-looped',
      });
      await store.flush();

      expect(store.getDetails('restarted')).toEqual([]);
    });

    it('does not carry one deploy offsets into the next', async () => {
      // The pending slot must clear when the episode closes, or a later boot
      // failure inherits a stale byte offset into a file that has since grown.
      openEpisode('carry', 'carry-1');
      store.noteRuntimeLog('carry', offsets);
      bus.publish('app:updated', { appId: 'carry', changes: { status: 'running' } });

      openEpisode('carry', 'carry-2');
      bus.publish('deploy:failed', { appId: 'carry', phase: 'boot', reason: 'crash-looped' });
      await store.flush();

      expect(store.getDetail('carry-2')?.runtimeLog).toBeUndefined();
    });
  });

  describe('correlation', () => {
    it('ignores a failure with no open episode (orphan guard)', async () => {
      // app:updated{errored} also fires from startup reconcile and API
      // restart, not only from deploys.
      bus.publish('build:failed', {
        appId: 'orphan',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      expect(store.getDetails('orphan')).toEqual([]);
    });

    it('records nothing when build:started carried no deployId', async () => {
      // There is no id to key a detail to. Better none than one under an id
      // nothing upstream can reference.
      bus.publish('build:started', { appId: 'noid', buildId: 'b1' });
      bus.publish('build:failed', {
        appId: 'noid',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      expect(store.getDetails('noid')).toEqual([]);
    });

    it('does not leak one app\'s failure onto another\'s open deploy', async () => {
      openEpisode('a', 'a-1');
      openEpisode('b', 'b-1');
      bus.publish('build:failed', {
        appId: 'b',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      expect(store.getDetail('b-1')?.appName).toBe('b');
      expect(store.getDetail('a-1')).toBeUndefined();
    });

    it('keeps exactly one record per deployId', async () => {
      openEpisode('dup', 'dup-1');
      bus.publish('build:failed', {
        appId: 'dup',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'install',
      });
      openEpisode('dup', 'dup-1');
      bus.publish('build:failed', {
        appId: 'dup',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      const all = store.getDetails('dup');
      expect(all).toHaveLength(1);
      expect(all[0].stage).toBe('build');
    });

    it('records nothing for a deploy that succeeded', async () => {
      openEpisode('happy', 'happy-1');
      bus.publish('app:updated', { appId: 'happy', changes: { status: 'running' } });
      await store.flush();

      expect(store.getDetails('happy')).toEqual([]);
    });
  });

  describe('retention at teardown (D4 / SEC-3)', () => {
    const offsets = {
      outFile: '/logs/app-2026-07-27-out.log',
      errFile: '/logs/app-2026-07-27-err.log',
      outStartOffset: 10,
      errStartOffset: 0,
    };

    const failBoot = (app: string, deployId: string) => {
      openEpisode(app, deployId);
      store.noteRuntimeLog(app, offsets);
      bus.publish('deploy:failed', { appId: app, phase: 'boot', reason: 'crash-looped' });
    };

    it('CLEARS the name-keyed log offsets', async () => {
      // THE SEC-3 assertion. outFile is keyed on the app name and teardown
      // frees that name — a surviving offset would resolve to whatever the
      // next tenant to claim the name is writing.
      failBoot('app', 'r-1');
      await store.flush();
      expect(store.getDetail('r-1')?.runtimeLog).toEqual(offsets);

      await store.retainForApp('app');

      expect(store.getDetail('r-1')?.runtimeLog).toBeUndefined();
    });

    it('keeps the DROP-generated metadata', async () => {
      // Severing the log pointer must not throw away the diagnosis — that is
      // the whole reason a torn-down deploy is worth retaining.
      openEpisode('m', 'r-2');
      bus.publish('build:failed', {
        appId: 'm',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'install',
        exitCode: 127,
        command: 'npm ci',
      });
      await store.flush();

      await store.retainForApp('m');

      expect(store.getDetail('r-2')).toMatchObject({ stage: 'install', exitCode: 127 });
    });

    it('stamps a window and stops serving the record once it closes', async () => {
      failBoot('w', 'r-3');
      await store.flush();
      await store.retainForApp('w');

      const until = store.getDetail('r-3')?.retainUntil;
      expect(until).toBeDefined();

      // Expiry is enforced on READ, not only by the sweep — the platform can
      // stay up for weeks, so a window that only closed on restart would not
      // be a window at all.
      await store.sweepExpired(Date.parse(until as string) + 1000);
      expect(store.getDetail('r-3')).toBeUndefined();
    });

    it('treats a malformed retainUntil as expired, not immortal', async () => {
      // NaN <= now is false, so a naive comparison keeps a hand-edited or
      // half-written record forever.
      failBoot('bad', 'r-4');
      await store.flush();
      await store.retainForApp('bad');
      (store.getDetail('r-4') as { retainUntil?: string }).retainUntil = 'not-a-date';

      expect(store.getDetail('r-4')).toBeUndefined();
    });

    it('persists the cleared offsets before returning to the caller', async () => {
      // The caller deletes the log directories immediately after this returns.
      // A crash before the write lands would reload the record with LIVE
      // name-keyed offsets and no retainUntil — the pre-fix state, and
      // invisible to the serve-time guard, which keys on retainUntil.
      failBoot('p', 'r-5');
      await store.flush();

      await store.retainForApp('p');

      const reloaded = new DeployDetailStore(storePath);
      await reloaded.initialize();
      expect(reloaded.getDetail('r-5')?.runtimeLog).toBeUndefined();
      expect(reloaded.getDetail('r-5')?.retainUntil).toBeDefined();
    });

    it('rejects a deployId that is not safe to use as a key', async () => {
      bus.publish('build:started', { appId: 'evil', buildId: 'b1', deployId: '../../escape' });
      bus.publish('build:failed', {
        appId: 'evil',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      expect(store.getDetails('evil')).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('survives a round trip to disk', async () => {
      openEpisode('persist', 'p-1');
      bus.publish('build:failed', {
        appId: 'persist',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'install',
        exitCode: 1,
      });
      await store.flush();

      const reloaded = new DeployDetailStore(storePath);
      await reloaded.initialize();
      expect(reloaded.getDetail('p-1')?.exitCode).toBe(1);
    });

    it('starts empty on a corrupt store rather than throwing', async () => {
      await fs.writeFile(storePath, '{ not json', 'utf-8');

      const reloaded = new DeployDetailStore(storePath);
      await expect(reloaded.initialize()).resolves.toBeUndefined();
      expect(reloaded.getDetails('anything')).toEqual([]);
    });

    it('purgeApp drops that app details and leaves others alone', async () => {
      openEpisode('gone', 'gone-1');
      bus.publish('build:failed', {
        appId: 'gone',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      openEpisode('stays', 'stays-1');
      bus.publish('build:failed', {
        appId: 'stays',
        buildId: 'b1',
        error: new Error('x'),
        stage: 'build',
      });
      await store.flush();

      store.purgeApp('gone');
      await store.flush();

      expect(store.getDetail('gone-1')).toBeUndefined();
      expect(store.getDetail('stays-1')).toBeDefined();
    });
  });
});
