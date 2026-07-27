/**
 * `ephemeral: true` on the MCP deploy surface.
 *
 * The dangerous reading of "ephemeral" is that it is a property a caller can
 * attach to an app. It is not — it must always produce a NEW, randomly named
 * app, or `ephemeral: true` becomes a way to put a self-deleting deadline on
 * somebody's real app.
 */

import type { AuthContext } from '../middleware/auth';

const deployMock = jest.fn().mockResolvedValue({ app: 'x', acceptedAt: 'now', isNew: true });

jest.mock('../../core/upload-deploy', () => ({
  getUploadDeployService: () => ({ deploy: deployMock }),
  ArchiveRejectedError: class extends Error {},
  UploadValidationError: class extends Error {},
  InsufficientDiskSpaceError: class extends Error {},
}));

const apps = new Map<string, { name: string; userId?: string; status?: string }>();
jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({
    getApp: (name: string) => apps.get(name),
    getAllApps: () => [...apps.values()],
    hasApp: (name: string) => apps.has(name),
  }),
}));

jest.mock('../../managers/activity', () => ({ tryLogActivity: async () => undefined }));

jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({ getEpisodes: () => [], hasOpenEpisode: () => false }),
}));

import { handleDeployFiles } from './tools';

const agentAuth: AuthContext = {
  userId: 'owner-1',
  username: 'bot',
  role: 'user',
  authMethod: 'apikey',
  kind: 'agent',
  principalId: 'key:tok',
};

const files = [{ path: 'index.js', content: 'x' }];

describe('deploy_files ephemeral', () => {
  beforeEach(() => {
    apps.clear();
    deployMock.mockClear();
    process.env.DROP_MCP_DEPLOY_WAIT_MS = '1';
  });

  afterEach(() => {
    delete process.env.DROP_MCP_DEPLOY_WAIT_MS;
  });

  const deployedName = () => deployMock.mock.calls[0][0].appName as string;

  it('deploys under the caller name when NOT ephemeral', async () => {
    await handleDeployFiles(agentAuth, { name: 'my-app', files });

    expect(deployedName()).toBe('my-app');
    expect(deployMock.mock.calls[0][0].ephemeral).toBe(false);
  });

  it('NEVER reuses the caller name for an ephemeral', async () => {
    // The load-bearing property. If `ephemeral: true` kept the caller's name it
    // would attach a self-deleting deadline to whatever app already has that
    // name — deleting someone's real app, and its database, on a timer.
    apps.set('my-app', { name: 'my-app', userId: 'owner-1', status: 'running' });

    await handleDeployFiles(agentAuth, { name: 'my-app', files, ephemeral: true });

    expect(deployedName()).not.toBe('my-app');
    expect(deployedName()).toMatch(/^my-app-[a-f0-9]{10}$/);
  });

  it('gives two ephemeral calls two different apps', async () => {
    // Otherwise repeat scratch deploys collide instead of being independent.
    await handleDeployFiles(agentAuth, { name: 'scratch', files, ephemeral: true });
    const first = deployedName();
    deployMock.mockClear();
    await handleDeployFiles(agentAuth, { name: 'scratch', files, ephemeral: true });

    expect(deployedName()).not.toBe(first);
  });

  it('passes the requested TTL through for clamping', async () => {
    await handleDeployFiles(agentAuth, {
      name: 'scratch',
      files,
      ephemeral: true,
      ttl_minutes: 30,
    });

    expect(deployMock.mock.calls[0][0].ttlMinutes).toBe(30);
  });

  it('marks ephemeral explicitly rather than leaving it undefined', async () => {
    // The service branches on it; `undefined` would read as false anyway, but
    // an explicit boolean keeps the request self-describing in the audit trail.
    await handleDeployFiles(agentAuth, { name: 'scratch', files, ephemeral: true });

    expect(deployMock.mock.calls[0][0].ephemeral).toBe(true);
  });

  it('still validates the caller-supplied name before deriving from it', async () => {
    const result = await handleDeployFiles(agentAuth, {
      name: '../escape',
      files,
      ephemeral: true,
    });

    expect(result.isError).toBe(true);
    expect(deployMock).not.toHaveBeenCalled();
  });
});
