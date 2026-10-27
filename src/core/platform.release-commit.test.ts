/**
 * A zero-downtime release remembers the git commit it was built from, and a
 * rollback to it puts that commit back (the snapshot rollback already did).
 *
 * Exercised on a constructed-but-never-started platform with stubbed
 * collaborators, as `platform.git-reservation.test.ts` does.
 */

import * as os from 'os';
import * as path from 'path';
import { createPlatform, DropPlatform } from './platform';

type Internals = {
  stateManager: unknown;
  appConfigService: unknown;
  releaseStore: unknown;
  runtime: unknown;
  detector: unknown;
  assertDependenciesCurrent: jest.Mock;
  cutoverEligibility: jest.Mock;
  cutoverTo: jest.Mock;
  doRestart: jest.Mock;
  commitServedPath(app: string, servedPath: string, slot?: 'a' | 'b'): Promise<void>;
  rollbackToRelease(
    app: string,
    release: { id: string; path: string; createdAt: string; gitCommit?: string }
  ): Promise<{ meta: { gitCommit?: string; kind?: string } }>;
};

describe('release rollback and the git commit', () => {
  let platform: DropPlatform;
  let p: Internals;
  let updateApp: jest.Mock;

  const release = { id: 'r1', path: '/rel/web/r1', createdAt: '2026-10-27T00:00:00Z', gitCommit: 'a'.repeat(40) };

  beforeEach(() => {
    const tempDir = path.join(os.tmpdir(), `drop-test-release-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
    p = platform as unknown as Internals;
    updateApp = jest.fn().mockResolvedValue(undefined);
    p.stateManager = {
      getApp: jest.fn().mockReturnValue({
        name: 'web',
        gitSource: { repoUrl: 'https://github.com/u/web', branch: 'main', lastCommitSha: 'b'.repeat(40) },
      }),
      updateApp,
    };
    p.appConfigService = { upsertConfig: jest.fn().mockResolvedValue(undefined), getConfig: jest.fn() };
    p.runtime = { getStatus: jest.fn().mockResolvedValue({ name: 'web' }) };
    p.detector = { detect: jest.fn().mockResolvedValue({ type: 'static' }) };
    p.assertDependenciesCurrent = jest.fn().mockResolvedValue(undefined);
    p.cutoverTo = jest.fn().mockResolvedValue({ ok: true });
    p.doRestart = jest.fn().mockResolvedValue({ name: 'web' });
    (p as unknown as { commitServedPath: unknown }).commitServedPath = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (platform.isActive()) await platform.stop();
  });

  it('a zero-downtime (cutover) rollback restores the commit the release was built from', async () => {
    p.cutoverEligibility = jest.fn().mockResolvedValue(3000);

    const { meta } = await p.rollbackToRelease('web', release);

    expect(updateApp).toHaveBeenCalledWith('web', {
      gitSource: { repoUrl: 'https://github.com/u/web', branch: 'main', lastCommitSha: 'a'.repeat(40) },
    });
    expect(meta.gitCommit).toBe('a'.repeat(40));
  });

  it('a rollback that restarts (no cutover possible) restores it too', async () => {
    p.cutoverEligibility = jest.fn().mockResolvedValue(null);

    await p.rollbackToRelease('web', release);

    expect(p.doRestart).toHaveBeenCalled();
    expect(updateApp).toHaveBeenCalledWith('web', {
      gitSource: expect.objectContaining({ lastCommitSha: 'a'.repeat(40) }),
    });
  });

  it('leaves the commit alone for a release recorded before commits were kept', async () => {
    p.cutoverEligibility = jest.fn().mockResolvedValue(3000);

    await p.rollbackToRelease('web', { id: 'r0', path: '/rel/web/r0', createdAt: 't' });

    expect(updateApp).not.toHaveBeenCalled();
  });
});

describe('a new release records its commit', () => {
  it('commitServedPath stamps the release with the commit the app is at', async () => {
    const tempDir = path.join(os.tmpdir(), `drop-test-release-stamp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
    const p = platform as unknown as Internals;
    const updateSystemConfig = jest.fn().mockResolvedValue(undefined);
    p.releaseStore = { isReleasePathOf: () => true, prune: jest.fn().mockResolvedValue(undefined) };
    p.appConfigService = { getConfig: jest.fn().mockReturnValue({}), updateSystemConfig };
    p.stateManager = {
      getApp: jest.fn().mockReturnValue({ name: 'web', gitSource: { lastCommitSha: 'c'.repeat(40) } }),
    };

    await p.commitServedPath('web', '/rel/web/r2');

    expect(updateSystemConfig).toHaveBeenCalledWith(
      'web',
      expect.objectContaining({
        currentRelease: expect.objectContaining({ path: '/rel/web/r2', gitCommit: 'c'.repeat(40) }),
      })
    );
  });

  it('a monorepo child is stamped with its group container\'s commit', async () => {
    const tempDir = path.join(os.tmpdir(), `drop-test-release-child-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
    const p = platform as unknown as Internals;
    const updateSystemConfig = jest.fn().mockResolvedValue(undefined);
    p.releaseStore = { isReleasePathOf: () => true, prune: jest.fn().mockResolvedValue(undefined) };
    p.appConfigService = {
      getConfig: jest.fn().mockReturnValue({ groupContainer: 'box' }),
      updateSystemConfig,
    };
    p.stateManager = {
      getApp: (n: string) =>
        n === 'box' ? { name: 'box', gitSource: { lastCommitSha: 'd'.repeat(40) } } : { name: n },
    };

    await p.commitServedPath('child', '/rel/child/r1');

    expect(updateSystemConfig).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ currentRelease: expect.objectContaining({ gitCommit: 'd'.repeat(40) }) })
    );
  });
});
