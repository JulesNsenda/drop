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
      bus.publish('deploy:failed', { appId: 'booty', phase: 'boot', reason: 'readiness-failed' });
      await store.flush();

      expect(store.getDetail('boot-1')).toMatchObject({
        deployId: 'boot-1',
        appName: 'booty',
        phase: 'boot',
        reason: 'readiness-failed',
      });
    });

    it('records exactly one detail across the real platform sequence', async () => {
      // The platform publishes deploy:failed and THEN writes 'errored', which
      // is also a close signal. Both reach this store; the outcome must be one
      // boot-phase record, not two and not a build-phase one overwriting it.
      openEpisode('seq', 'seq-1');
      bus.publish('deploy:failed', { appId: 'seq', phase: 'boot', reason: 'readiness-failed' });
      bus.publish('app:updated', { appId: 'seq', changes: { status: 'errored' } });
      await store.flush();

      const all = store.getDetails('seq');
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ deployId: 'seq-1', phase: 'boot' });
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
