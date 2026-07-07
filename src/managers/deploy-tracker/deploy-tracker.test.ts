/**
 * DeployTracker Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { EventBus } from '../../core/event-bus';
import { DeployTracker } from './deploy-tracker';

describe('DeployTracker', () => {
  let tmpDir: string;
  let storePath: string;
  let bus: EventBus;
  let tracker: DeployTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploy-tracker-test-'));
    storePath = path.join(tmpDir, 'deploys.json');
    bus = new EventBus();
    tracker = new DeployTracker(storePath);
    await tracker.initialize();
    tracker.subscribe(bus);
  });

  afterEach(async () => {
    await tracker.flush();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('PM2 happy path: detect -> build -> running closes with a full stage timeline', async () => {
    bus.publish('app:detected', { name: 'app1', path: '/webapps/app1' });
    bus.publish('build:started', { appId: 'app1', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app1', buildId: 'b1', durationMs: 100, success: true });
    bus.publish('app:updated', { appId: 'app1', changes: { status: 'running' } });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app1');
    expect(episodes).toHaveLength(1);

    const episode = episodes[0];
    expect(episode.status).toBe('succeeded');
    expect(episode.trigger).toBe('deploy');
    expect(episode.stages.map((s) => s.stage)).toEqual([
      'triggered',
      'build-started',
      'build',
      'running',
    ]);
    expect(episode.durationMs).toBeGreaterThanOrEqual(0);
    for (const stage of episode.stages.slice(1)) {
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('docker happy path (regression lock): closes on app:updated{running} with no app:started/app:starting ever', async () => {
    bus.publish('app:detected', { name: 'app2', path: '/webapps/app2' });
    bus.publish('build:started', { appId: 'app2', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app2', buildId: 'b1', durationMs: 50, success: true });
    // No app:started / app:starting anywhere in this stream — docker isolation
    // never emits them. The close must happen purely on app:updated{running}.
    bus.publish('app:updated', { appId: 'app2', changes: { status: 'running' } });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app2');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].status).toBe('succeeded');
  });

  it('hot-reload: app:update tags the trigger as hot-reload', async () => {
    bus.publish('app:update', { name: 'app3', path: '/webapps/app3', reason: 'file-change' });
    bus.publish('build:started', { appId: 'app3', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app3', buildId: 'b1', durationMs: 20, success: true });
    bus.publish('app:updated', { appId: 'app3', changes: { status: 'running' } });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app3');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].trigger).toBe('hot-reload');
    expect(episodes[0].status).toBe('succeeded');
  });

  it('build failure: status is failed, build stage carries ok:false, no raw error text stored, closes on build:failed', async () => {
    bus.publish('app:detected', { name: 'app4', path: '/webapps/app4' });
    bus.publish('build:started', { appId: 'app4', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app4', buildId: 'b1', durationMs: 10, success: false });
    bus.publish('build:failed', {
      appId: 'app4',
      buildId: 'b1',
      error: new Error('/etc/secret/abs/path leaked DATABASE_URL=postgres://user:pw@host/db'),
    });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app4');
    expect(episodes).toHaveLength(1);

    const episode = episodes[0];
    expect(episode.status).toBe('failed');
    expect(episode.stages.map((s) => s.stage)).toEqual([
      'triggered',
      'build-started',
      'build',
      'build-failed',
    ]);

    const buildStage = episode.stages.find((s) => s.stage === 'build');
    expect(buildStage?.ok).toBe(false);

    const serialized = JSON.stringify(episode);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('DATABASE_URL');
    expect(serialized).not.toContain('postgres://');
  });

  it('DB-provisioning failure (no app:error path): app:updated{errored} closes as failed', async () => {
    bus.publish('app:detected', { name: 'app5', path: '/webapps/app5' });
    bus.publish('build:started', { appId: 'app5', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app5', buildId: 'b1', durationMs: 10, success: true });
    bus.publish('app:updated', { appId: 'app5', changes: { status: 'errored' } });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app5');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].status).toBe('failed');
    expect(episodes[0].stages.map((s) => s.stage)).toEqual([
      'triggered',
      'build-started',
      'build',
      'errored',
    ]);
  });

  it('orphan-close guard: app:updated{running} with no preceding build:started creates no episode', async () => {
    bus.publish('app:updated', { appId: 'app6', changes: { status: 'running' } });
    await tracker.flush();

    expect(tracker.getEpisodes('app6')).toEqual([]);
  });

  it('orphan-close guard: a stray build:failed with no open episode is ignored', async () => {
    bus.publish('build:failed', { appId: 'app7', buildId: 'bx', error: new Error('boom') });
    await tracker.flush();

    expect(tracker.getEpisodes('app7')).toEqual([]);
  });

  it('orphan-close guard also covers other app:updated statuses (pending/building/starting/stopped ignored)', async () => {
    bus.publish('build:started', { appId: 'app6b', buildId: 'b1' });
    bus.publish('app:updated', { appId: 'app6b', changes: { status: 'building' } });
    bus.publish('app:updated', { appId: 'app6b', changes: { status: 'starting' } });
    bus.publish('app:updated', { appId: 'app6b', changes: { status: 'stopped' } });
    await tracker.flush();

    // Episode is still open (in-progress) — none of those statuses close it.
    const episodes = tracker.getEpisodes('app6b');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].status).toBe('in-progress');
  });

  it('supersede: two build:started for the same app without a close between', async () => {
    bus.publish('app:detected', { name: 'app8', path: '/webapps/app8' });
    bus.publish('build:started', { appId: 'app8', buildId: 'b1' });
    bus.publish('build:started', { appId: 'app8', buildId: 'b2' });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app8');
    expect(episodes).toHaveLength(2);
    // Newest-first: the second (still-active) build is in-progress, the first
    // never closed and is superseded by it.
    expect(episodes[0].status).toBe('in-progress');
    expect(episodes[1].status).toBe('superseded');
  });

  it('purgeApp removes only the target app episodes, leaving other apps intact', async () => {
    bus.publish('app:detected', { name: 'app9', path: '/webapps/app9' });
    bus.publish('build:started', { appId: 'app9', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app9', buildId: 'b1', durationMs: 10, success: true });
    bus.publish('app:updated', { appId: 'app9', changes: { status: 'running' } });

    bus.publish('app:detected', { name: 'app10', path: '/webapps/app10' });
    bus.publish('build:started', { appId: 'app10', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app10', buildId: 'b1', durationMs: 10, success: true });
    bus.publish('app:updated', { appId: 'app10', changes: { status: 'running' } });
    await tracker.flush();

    tracker.purgeApp('app9');
    await tracker.flush();

    expect(tracker.getEpisodes('app9')).toEqual([]);
    expect(tracker.getEpisodes('app10')).toHaveLength(1);
  });

  it('persistence round-trip: a new DeployTracker on the same storePath reads back the episode', async () => {
    bus.publish('app:detected', { name: 'app11', path: '/webapps/app11' });
    bus.publish('build:started', { appId: 'app11', buildId: 'b1' });
    bus.publish('build:completed', { appId: 'app11', buildId: 'b1', durationMs: 10, success: true });
    bus.publish('app:updated', { appId: 'app11', changes: { status: 'running' } });
    await tracker.flush();

    const tracker2 = new DeployTracker(storePath);
    await tracker2.initialize();

    const episodes = tracker2.getEpisodes('app11');
    expect(episodes).toHaveLength(1);
    expect(episodes[0].status).toBe('succeeded');
    expect(episodes[0].stages.map((s) => s.stage)).toEqual([
      'triggered',
      'build-started',
      'build',
      'running',
    ]);
  });

  it('sanitization: build-failed rows never carry an absolute path or the store directory', async () => {
    bus.publish('app:detected', { name: 'app12', path: '/webapps/app12' });
    bus.publish('build:started', { appId: 'app12', buildId: 'b1' });
    bus.publish('build:failed', {
      appId: 'app12',
      buildId: 'b1',
      error: new Error(`ENOENT: ${path.join(tmpDir, 'node_modules', 'missing')}`),
    });
    await tracker.flush();

    const episodes = tracker.getEpisodes('app12');
    expect(episodes).toHaveLength(1);

    const serialized = JSON.stringify(episodes);
    expect(serialized).not.toContain(tmpDir);
    expect(serialized.toLowerCase()).not.toContain('enoent');

    // Also verify what actually landed on disk, not just the derived read.
    const onDisk = await fs.readFile(storePath, 'utf-8');
    expect(onDisk).not.toContain(tmpDir);
    expect(onDisk.toLowerCase()).not.toContain('enoent');
  });

  it('getEpisodes applies limit and stays newest-first across apps', async () => {
    for (const name of ['appA', 'appB', 'appC']) {
      bus.publish('app:detected', { name, path: `/webapps/${name}` });
      bus.publish('build:started', { appId: name, buildId: 'b1' });
      bus.publish('build:completed', { appId: name, buildId: 'b1', durationMs: 5, success: true });
      bus.publish('app:updated', { appId: name, changes: { status: 'running' } });
    }
    await tracker.flush();

    const all = tracker.getEpisodes();
    expect(all.length).toBeGreaterThanOrEqual(3);

    const limited = tracker.getEpisodes(undefined, 1);
    expect(limited).toHaveLength(1);
    // The most recently started episode (appC) should be first.
    expect(limited[0].appName).toBe('appC');
  });

  it('subscribe() returns a single Unsubscribe that tears down every handler', async () => {
    const localBus = new EventBus();
    const localTracker = new DeployTracker(path.join(tmpDir, 'unsub-deploys.json'));
    await localTracker.initialize();

    const unsubscribe = localTracker.subscribe(localBus);
    unsubscribe();

    localBus.publish('app:detected', { name: 'appZ', path: '/webapps/appZ' });
    localBus.publish('build:started', { appId: 'appZ', buildId: 'b1' });
    localBus.publish('build:completed', { appId: 'appZ', buildId: 'b1', durationMs: 5, success: true });
    localBus.publish('app:updated', { appId: 'appZ', changes: { status: 'running' } });
    await localTracker.flush();

    expect(localTracker.getEpisodes('appZ')).toEqual([]);
  });
});
