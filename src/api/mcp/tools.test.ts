/**
 * Unit tests for MCP tool handlers (PRD-040).
 *
 * Calls the exported handlers directly — no HTTP/MCP-protocol layer here
 * (that's covered by mcp.integration.test.ts). Services that would otherwise
 * touch the filesystem/PM2/git are mocked at the singleton layer, mirroring
 * apps.source.test.ts's style. Real fs + tar operations run for the
 * deploy_files staging path (small temp-dir fixtures only).
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

import {
  handleDeployFiles,
  handleDeployFromGit,
  handleListApps,
  handleAppStatus,
  handleAppLogs,
  handleRestartApp,
  DEPLOY_FILES_MAX_FILES,
  DEPLOY_FILES_MAX_TOTAL_BYTES,
} from './tools';
import { AuthContext } from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps, AppInProgressError } from '../platform-ops';
import { resetUploadPreflightState } from '../upload-preflight';
import * as diskUtils from '../../utils/disk';
import * as runtimeConfigModule from '../runtime-config';
import * as uploadDeployModule from '../../core/upload-deploy';
import * as gitDeployModule from '../../core/git-deploy';
import * as deployTrackerModule from '../../managers/deploy-tracker';
import * as buildLogModule from '../../managers/build-log/build-log';
import * as runtimeModule from '../../managers/runtime';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Every tool result in this test file uses a single text content block. */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  if (block.type !== 'text') {
    throw new Error(`Expected a text content block, got '${block.type}'`);
  }
  return block.text;
}

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    isAppInProgress: jest.fn().mockReturnValue(false),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    ...overrides,
  };
}

const alice: AuthContext = {
  userId: 'alice-id',
  username: 'alice',
  role: 'user',
  authMethod: 'apikey',
};
const bob: AuthContext = { userId: 'bob-id', username: 'bob', role: 'user', authMethod: 'apikey' };

describe('MCP tool handlers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mcp-tools-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    resetStateManager();
    resetPlatformOps();
    resetUploadPreflightState();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    setPlatformOps(makeOps());

    jest.spyOn(runtimeConfigModule, 'getTempDirectory').mockReturnValue(path.join(tempDir, 'temp'));
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });

    await getStateManager().registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await getStateManager().updateApp('alice-app', { userId: alice.userId });
  });

  afterEach(async () => {
    resetPlatformOps();
    resetUploadPreflightState();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('deploy_files', () => {
    it('rejects a foreign app (no existence oracle) without calling the deploy service', async () => {
      const deployMock = jest.fn();
      jest
        .spyOn(uploadDeployModule, 'getUploadDeployService')
        .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
          typeof uploadDeployModule.getUploadDeployService
        >);

      const result = await handleDeployFiles(bob, {
        name: 'alice-app',
        files: [{ path: 'index.js', content: 'x' }],
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("Application 'alice-app' not found");
      expect(deployMock).not.toHaveBeenCalled();
    });

    it('surfaces the shared preflight message for a stopped app', async () => {
      await getStateManager().setAppStatus('alice-app', 'stopped');
      const deployMock = jest.fn();
      jest
        .spyOn(uploadDeployModule, 'getUploadDeployService')
        .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
          typeof uploadDeployModule.getUploadDeployService
        >);

      const result = await handleDeployFiles(alice, {
        name: 'alice-app',
        files: [{ path: 'index.js', content: 'x' }],
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('is stopped; start or remove it before uploading');
      expect(deployMock).not.toHaveBeenCalled();
    });

    it.each([['../evil.txt'], ['/etc/passwd'], ['a\\..\\b']])(
      'rejects a path-escaping file entry: %s',
      async badPath => {
        const deployMock = jest.fn();
        jest
          .spyOn(uploadDeployModule, 'getUploadDeployService')
          .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
            typeof uploadDeployModule.getUploadDeployService
          >);

        const result = await handleDeployFiles(alice, {
          name: 'escape-app',
          files: [{ path: badPath, content: 'x' }],
        });

        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain('Rejected');
        expect(deployMock).not.toHaveBeenCalled();
      }
    );

    it('rejects a file count beyond the cap without calling the deploy service', async () => {
      const deployMock = jest.fn();
      jest
        .spyOn(uploadDeployModule, 'getUploadDeployService')
        .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
          typeof uploadDeployModule.getUploadDeployService
        >);
      const files = Array.from({ length: DEPLOY_FILES_MAX_FILES + 1 }, (_, i) => ({
        path: `f${i}.txt`,
        content: 'x',
      }));

      const result = await handleDeployFiles(alice, { name: 'cap-app', files });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('Too many files');
      expect(deployMock).not.toHaveBeenCalled();
    });

    it('rejects total content size beyond the cap without calling the deploy service', async () => {
      const deployMock = jest.fn();
      jest
        .spyOn(uploadDeployModule, 'getUploadDeployService')
        .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
          typeof uploadDeployModule.getUploadDeployService
        >);
      const big = 'x'.repeat(DEPLOY_FILES_MAX_TOTAL_BYTES + 1);

      const result = await handleDeployFiles(alice, {
        name: 'cap-app-2',
        files: [{ path: 'big.txt', content: big }],
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('exceeding');
      expect(deployMock).not.toHaveBeenCalled();
    });

    it('happy path: stages files, tars them, and returns the app URL text on a succeeded episode', async () => {
      const deployMock = jest.fn().mockResolvedValue({
        app: 'new-app',
        acceptedAt: '2026-07-09T00:00:00.000Z',
        isNew: true,
      });
      jest
        .spyOn(uploadDeployModule, 'getUploadDeployService')
        .mockReturnValue({ deploy: deployMock } as unknown as ReturnType<
          typeof uploadDeployModule.getUploadDeployService
        >);
      jest.spyOn(deployTrackerModule, 'getDeployTracker').mockReturnValue({
        getEpisodes: jest.fn().mockReturnValue([
          {
            deployId: 'd1',
            appName: 'new-app',
            status: 'succeeded',
            startedAt: '2026-07-09T00:00:01.000Z',
            stages: [],
          },
        ]),
      } as unknown as ReturnType<typeof deployTrackerModule.getDeployTracker>);

      const result = await handleDeployFiles(alice, {
        name: 'new-app',
        files: [
          { path: 'index.js', content: 'console.log(1)' },
          { path: 'sub/dir/file.txt', content: 'nested' },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('succeeded');
      expect(deployMock).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: 'new-app',
          userId: 'alice-id',
          archivePath: expect.any(String),
        })
      );
    });

    it('build-failure path includes untrusted markers, the failing stage, and a log tail', async () => {
      jest.spyOn(uploadDeployModule, 'getUploadDeployService').mockReturnValue({
        deploy: jest
          .fn()
          .mockResolvedValue({
            app: 'fail-app',
            acceptedAt: '2026-07-09T00:00:00.000Z',
            isNew: true,
          }),
      } as unknown as ReturnType<typeof uploadDeployModule.getUploadDeployService>);
      jest.spyOn(deployTrackerModule, 'getDeployTracker').mockReturnValue({
        getEpisodes: jest.fn().mockReturnValue([
          {
            deployId: 'd2',
            appName: 'fail-app',
            status: 'failed',
            startedAt: '2026-07-09T00:00:01.000Z',
            stages: [
              { stage: 'build-failed', at: '2026-07-09T00:00:02.000Z', category: 'build-failed' },
            ],
          },
        ]),
      } as unknown as ReturnType<typeof deployTrackerModule.getDeployTracker>);
      jest.spyOn(buildLogModule, 'getBuildLogService').mockReturnValue({
        getLatestBuildLog: jest.fn().mockResolvedValue('line1\nline2\nERROR: build broke'),
      } as unknown as ReturnType<typeof buildLogModule.getBuildLogService>);

      const result = await handleDeployFiles(alice, {
        name: 'fail-app',
        files: [{ path: 'index.js', content: 'x' }],
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('build-failed');
      expect(firstText(result)).toContain('BEGIN UNTRUSTED');
      expect(firstText(result)).toContain('END UNTRUSTED');
      expect(firstText(result)).toContain('ERROR: build broke');
    });

    it('returns a "still building" message once the deploy wait budget elapses', async () => {
      const original = process.env.DROP_MCP_DEPLOY_WAIT_MS;
      process.env.DROP_MCP_DEPLOY_WAIT_MS = '50';
      try {
        jest.spyOn(uploadDeployModule, 'getUploadDeployService').mockReturnValue({
          deploy: jest
            .fn()
            .mockResolvedValue({
              app: 'slow-app',
              acceptedAt: '2026-07-09T00:00:00.000Z',
              isNew: true,
            }),
        } as unknown as ReturnType<typeof uploadDeployModule.getUploadDeployService>);
        jest.spyOn(deployTrackerModule, 'getDeployTracker').mockReturnValue({
          getEpisodes: jest.fn().mockReturnValue([]), // never a matching episode
        } as unknown as ReturnType<typeof deployTrackerModule.getDeployTracker>);

        const result = await handleDeployFiles(alice, {
          name: 'slow-app',
          files: [{ path: 'index.js', content: 'x' }],
        });

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain('still building');
        expect(firstText(result)).toContain('app_status');
      } finally {
        if (original === undefined) delete process.env.DROP_MCP_DEPLOY_WAIT_MS;
        else process.env.DROP_MCP_DEPLOY_WAIT_MS = original;
      }
    }, 10000);

    it('parked path: reports needs-config with the missing secrets instead of hanging (PRD-051)', async () => {
      // App parked by the preflight: needs-config + missingSecrets, updated
      // "now" (>= the deploy's acceptedAt), with NO terminal deploy episode.
      await getStateManager().registerApp('park-app', path.join(tempDir, 'park-app'));
      await getStateManager().updateApp('park-app', { userId: alice.userId });
      await getStateManager().setAppStatus('park-app', 'needs-config', { missingSecrets: ['JWT_SECRET'] });

      jest.spyOn(uploadDeployModule, 'getUploadDeployService').mockReturnValue({
        deploy: jest
          .fn()
          .mockResolvedValue({ app: 'park-app', acceptedAt: '2026-07-09T00:00:00.000Z', isNew: false }),
      } as unknown as ReturnType<typeof uploadDeployModule.getUploadDeployService>);
      // No matching terminal episode — the status short-circuit must fire, not a 120s hang.
      jest.spyOn(deployTrackerModule, 'getDeployTracker').mockReturnValue({
        getEpisodes: jest.fn().mockReturnValue([]),
      } as unknown as ReturnType<typeof deployTrackerModule.getDeployTracker>);

      const result = await handleDeployFiles(alice, {
        name: 'park-app',
        files: [{ path: 'index.js', content: 'x' }],
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('JWT_SECRET');
      expect(firstText(result)).toMatch(/parked|needs/i);
    }, 10000);
  });

  describe('deploy_from_git', () => {
    it('reports git unavailable as a tool error', async () => {
      jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
        isAvailable: jest.fn().mockReturnValue(false),
        deploy: jest.fn(),
      } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);

      const result = await handleDeployFromGit(alice, { url: 'https://github.com/acme/widgets' });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('git CLI is not available');
    });

    it('happy path waits for the episode and returns success text', async () => {
      jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
        isAvailable: jest.fn().mockReturnValue(true),
        deploy: jest.fn().mockResolvedValue({
          appName: 'widgets',
          repoUrl: 'https://github.com/acme/widgets',
          branch: 'main',
          clonedAt: '2026-07-09T00:00:00.000Z',
        }),
      } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);
      jest.spyOn(deployTrackerModule, 'getDeployTracker').mockReturnValue({
        // deploy_from_git's `acceptedAt` is real wall-clock time (there's no
        // mocked deploy() response to source it from, unlike deploy_files) —
        // the episode's startedAt must be computed at call time too, so it's
        // always >= whatever acceptedAt the handler captured a moment earlier.
        getEpisodes: jest
          .fn()
          .mockImplementation(() => [
            {
              deployId: 'd3',
              appName: 'widgets',
              status: 'succeeded',
              startedAt: new Date().toISOString(),
              stages: [],
            },
          ]),
      } as unknown as ReturnType<typeof deployTrackerModule.getDeployTracker>);

      const result = await handleDeployFromGit(alice, { url: 'https://github.com/acme/widgets' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('succeeded');
    });
  });

  describe('list_apps / app_status / app_logs / restart_app', () => {
    it("list_apps only shows the caller's own apps for a non-admin key", async () => {
      await getStateManager().registerApp('bob-app', path.join(tempDir, 'bob-app'));
      await getStateManager().updateApp('bob-app', { userId: bob.userId });

      const result = handleListApps(alice);
      expect(firstText(result)).toContain('alice-app');
      expect(firstText(result)).not.toContain('bob-app');
    });

    it('app_status: foreign app returns not-found text and isError', () => {
      const result = handleAppStatus(bob, { name: 'alice-app' });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("Application 'alice-app' not found");
    });

    it('app_status: owner sees status fields', () => {
      const result = handleAppStatus(alice, { name: 'alice-app' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('name: alice-app');
      expect(firstText(result)).toContain('status:');
    });

    it('app_logs: foreign app returns not-found text and isError', async () => {
      const result = await handleAppLogs(bob, { name: 'alice-app' });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("Application 'alice-app' not found");
    });

    it('app_logs: owner sees untrusted-framed log content', async () => {
      jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue({
        getLogs: jest.fn().mockResolvedValue('hello from the app\nsecond line'),
      } as unknown as ReturnType<typeof runtimeModule.getAppRuntime>);

      const result = await handleAppLogs(alice, { name: 'alice-app' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('BEGIN UNTRUSTED');
      expect(firstText(result)).toContain('hello from the app');
    });

    it('restart_app: foreign app returns not-found text without invoking platform ops', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const result = await handleRestartApp(bob, { name: 'alice-app' });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe("Application 'alice-app' not found");
      expect(ops.restartApp).not.toHaveBeenCalled();
    });

    it('restart_app: owner triggers restartApp and gets a success message', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const result = await handleRestartApp(alice, { name: 'alice-app' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('restarted');
      expect(ops.restartApp).toHaveBeenCalledWith('alice-app');
    });

    it('restart_app: maps AppInProgressError to a tool error', async () => {
      setPlatformOps(
        makeOps({ restartApp: jest.fn().mockRejectedValue(new AppInProgressError('alice-app')) })
      );

      const result = await handleRestartApp(alice, { name: 'alice-app' });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('operation in progress');
    });
  });
});
