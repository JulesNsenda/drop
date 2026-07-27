/**
 * Scope enforcement at the MCP tools (Step 6c).
 *
 * Admission gets an agent token through the door; these are the checks that
 * decide what it can do once inside. The deploy_from_git case is the one that
 * matters most: that tool ALWAYS creates a new app, and it performed no scope
 * check at all — so a token holding nothing but `app:something:read` could
 * clone, build and RUN arbitrary code as its owner.
 */

import type { AuthContext } from '../middleware/auth';

const apps = new Map<string, { name: string; userId?: string; status?: string }>();

jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({
    getApp: (name: string) => apps.get(name),
    getAllApps: () => [...apps.values()],
  }),
}));

jest.mock('../../core/git-deploy', () => ({
  getGitDeployService: () => ({
    // Available, so the tool proceeds far enough to reach the scope guard.
    isAvailable: () => true,
    deployFromGit: jest.fn().mockResolvedValue({ appName: 'x' }),
  }),
}));

import { handleDeployFromGit, handleRestartApp, handleAppStatus } from './tools';

const agent = (scopes: string[]): AuthContext => ({
  userId: 'owner-1',
  username: 'deploy-bot',
  role: 'none',
  authMethod: 'apikey',
  scopes,
  kind: 'agent',
  principalId: 'key:k1',
});

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

describe('agent scope enforcement', () => {
  beforeEach(() => {
    apps.clear();
    apps.set('mine', { name: 'mine', userId: 'owner-1', status: 'running' });
    apps.set('other', { name: 'other', userId: 'someone-else' });
  });

  describe('deploy_from_git', () => {
    it('REFUSES a token without apps:create', async () => {
      // The blocker. Without this guard, the weakest possible grant —
      // read on one app — buys arbitrary code execution as the owner.
      const res = await handleDeployFromGit(agent(['app:mine:read']), {
        url: 'https://github.com/attacker/payload',
      } as never);

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('apps:create');
    });

    it('REFUSES even a deploy grant on another app', async () => {
      // app:<name>:deploy is authority over THAT app, not authority to create.
      const res = await handleDeployFromGit(agent(['app:mine:deploy']), {
        url: 'https://github.com/x/y',
      } as never);

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('apps:create');
    });

    it('lets a token WITH apps:create past the scope guard', async () => {
      // Asserts only that the scope check is not what stops it — whatever
      // happens downstream is a different concern.
      const res = await handleDeployFromGit(agent(['apps:create']), {
        url: 'https://github.com/x/y',
      } as never);

      expect(textOf(res)).not.toContain('apps:create scope');
    });

    it('rejects a traversal-shaped app name', async () => {
      // The git service's own regex is looser than isValidAppName and admits
      // '..'; containment downstream is accidental.
      const res = await handleDeployFromGit(agent(['apps:create']), {
        url: 'https://github.com/x/y',
        name: '..',
      } as never);

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Invalid app name');
    });
  });

  describe('verb separation', () => {
    it('refuses restart_app to a READ-only grant', async () => {
      // A restart replaces what is currently serving.
      const res = await handleRestartApp(agent(['app:mine:read']), { name: 'mine' });

      expect(res.isError).toBe(true);
    });

    it('allows app_status to a read grant', () => {
      const res = handleAppStatus(agent(['app:mine:read']), { name: 'mine' });

      expect(res.isError).toBeUndefined();
    });
  });

  describe('app separation', () => {
    it('refuses an app the token was not granted, even when the owner owns it', async () => {
      apps.set('sibling', { name: 'sibling', userId: 'owner-1' });

      const res = handleAppStatus(agent(['app:mine:read']), { name: 'sibling' });

      expect(res.isError).toBe(true);
    });

    it("refuses another tenant's app outright", () => {
      const res = handleAppStatus(agent(['app:other:read']), { name: 'other' });

      // Scope alone is not enough — canAccess still applies, so a scope that
      // outlived an ownership transfer grants nothing.
      expect(res.isError).toBe(true);
    });
  });
});
