/**
 * A materialized monorepo CHILD must never be onboarded or rebuilt on its own.
 *
 * The bug this pins, observed on dropkit.sh: `ezsign-frontend` served HTTP 500
 * on every request, with nginx logging
 *
 *   rewrite or internal redirection cycle while internally redirecting to "/index.html"
 *
 * — i.e. its document root had no `index.html`. The cause was ordering, not
 * nginx. The watcher's boot scan onboards every first-level folder under
 * webapps, including the `<group>-<service>` folders expandMonorepo copies out
 * of a monorepo. Each child published its own `app:detected`, started building
 * independently, and the container's expansion then landed `fs.rm` + `fs.cp`
 * underneath — replacing the tree with a fresh copy of the SOURCE, with no
 * build output, while the child's nginx was already pointed at `dist`.
 *
 * `reconcileApp` already refuses grouped apps for precisely this reason, but
 * `DROP_BOOT_RECONCILE` defaults to 'off', so on a default box that guard never
 * ran and this path did.
 *
 * These tests drive `handleAppDetected`/`handleAppUpdate` directly — the same
 * reason they were extracted from the event subscription: it exercises the
 * decision without racing real fs I/O through the bus's fire-and-forget
 * dispatch.
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';

describe('grouped monorepo children are the container’s to build', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let handleBuildApp: jest.Mock;
  let markAppKnown: jest.Mock;
  let configs: Map<string, { name: string; path: string; group?: string }>;
  let states: Map<
    string,
    { name: string; group?: string; isGroupContainer?: boolean; status?: string }
  >;

  const detectedPayload = (name: string, origin?: 'watcher' | 'upload') => ({
    name,
    path: path.join(tempDir, name),
    type: 'static' as const,
    ...(origin ? { origin } : {}),
  });

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-grouped-guard-${Date.now()}-${Math.random()}`);
    configs = new Map();
    states = new Map();

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    handleBuildApp = jest.fn().mockResolvedValue(undefined);
    markAppKnown = jest.fn();

    (platform as any).handleBuildApp = handleBuildApp;
    (platform as any).watcher = { markAppKnown };
    (platform as any).appConfigService = {
      getConfig: (n: string) => configs.get(n),
      upsertConfig: jest.fn().mockResolvedValue(undefined),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).stateManager = {
      getApp: (n: string) => states.get(n),
      registerApp: jest.fn().mockResolvedValue(undefined),
      updateApp: jest.fn().mockResolvedValue(undefined),
      hasApp: jest.fn().mockReturnValue(true),
      setAppStatus: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('isGroupedChild', () => {
    const isGroupedChild = (name: string): boolean =>
      (platform as any).isGroupedChild(name);

    it('is true from the CONFIG alone (state not yet loaded)', () => {
      // Split from the state-only case below so each half of the disjunction is
      // pinned independently — with both set, deleting either half still passed.
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });
      expect(isGroupedChild('ezsign-frontend')).toBe(true);
    });

    it('is true from the STATE alone (config lost or not yet written)', () => {
      // This half is what covers a child whose config file went missing but
      // whose apps.json entry survived — syncStateWithConfigs keeps it fed.
      states.set('ezsign-frontend', { name: 'ezsign-frontend', group: 'ezsign' });
      expect(isGroupedChild('ezsign-frontend')).toBe(true);
    });

    it('is FALSE for the container itself, which carries isGroupContainer', () => {
      // The container must still be onboarded — it is the thing that expands.
      states.set('ezsign', { name: 'ezsign', group: 'ezsign', isGroupContainer: true });
      expect(isGroupedChild('ezsign')).toBe(false);
    });

    it('is false for an ordinary standalone app', () => {
      configs.set('waitlist', { name: 'waitlist', path: '/x' });
      states.set('waitlist', { name: 'waitlist' });
      expect(isGroupedChild('waitlist')).toBe(false);
    });

    it('is false for an app DROP knows nothing about yet', () => {
      // A brand-new folder has neither config nor state; it must onboard
      // normally rather than being mistaken for someone's child.
      expect(isGroupedChild('brand-new')).toBe(false);
    });

    it('trusts the persisted config when state has not loaded the group yet', () => {
      configs.set('ezsign-backend', { name: 'ezsign-backend', path: '/x', group: 'ezsign' });
      expect(isGroupedChild('ezsign-backend')).toBe(true);
    });
  });

  describe('handleAppDetected', () => {
    it('does NOT build a grouped child — the boot race that broke ezsign', async () => {
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });
      states.set('ezsign-frontend', { name: 'ezsign-frontend', group: 'ezsign' });

      await (platform as any).handleAppDetected(detectedPayload('ezsign-frontend', 'watcher'));

      expect(handleBuildApp).not.toHaveBeenCalled();
    });

    it('does not register or rewrite the child’s config', async () => {
      // The container owns those writes; racing them is how a child ends up
      // with a config describing a tree that has been replaced.
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });

      await (platform as any).handleAppDetected(detectedPayload('ezsign-frontend', 'watcher'));

      expect((platform as any).appConfigService.upsertConfig).not.toHaveBeenCalled();
      expect((platform as any).stateManager.registerApp).not.toHaveBeenCalled();
    });

    it('still builds an ordinary standalone app', async () => {
      // The guard must not become a blanket refusal.
      configs.set('waitlist', { name: 'waitlist', path: '/x' });

      await (platform as any).handleAppDetected(detectedPayload('waitlist', 'watcher'));

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
      expect(handleBuildApp).toHaveBeenCalledWith(
        expect.any(String),
        'waitlist',
        'static',
        expect.anything()
      );
    });

    it('HONOURS an API-originated detection for a grouped child', async () => {
      // The regression this nearly shipped: migrate-runtime STOPS the app and
      // then publishes app:detected to bring it back. Keying the refusal on
      // identity rather than provenance left a migrated child down for good,
      // with one log line as the only symptom.
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });
      states.set('ezsign-frontend', { name: 'ezsign-frontend', group: 'ezsign' });

      // No origin === not the watcher === someone deliberately asked.
      await (platform as any).handleAppDetected(detectedPayload('ezsign-frontend'));

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
    });

    it('honours an upload-deploy detection for a grouped child', async () => {
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });

      await (platform as any).handleAppDetected(detectedPayload('ezsign-frontend', 'upload'));

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
    });

    it('builds a standalone app even if it were tagged with a group', async () => {
      // Names the invariant the guard depends on: only expandMonorepo writes
      // AppConfig.group, so a standalone app declaring `group:` in its own
      // drop.yaml never acquires the field. If a future feature starts copying
      // it in, this is the contract that should be revisited — the guard would
      // otherwise silently stop building every app that opts in.
      configs.set('solo', { name: 'solo', path: '/x' });

      await (platform as any).handleAppDetected(detectedPayload('solo', 'watcher'));

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleAppUpdate', () => {
    // The container's own fs.cp into a child folder makes the watcher fire an
    // incidental app:update for that child — rebuilding there races the very
    // copy that is writing the files.
    // Signature is (appName, appPath, reason, bypassCooldown?, actor?) — the
    // `reason` slot is easy to mis-fill, which silently makes bypassCooldown
    // undefined and flips which branch runs.
    const update = (name: string, bypassCooldown: boolean) =>
      (platform as any).handleAppUpdate(name, path.join(tempDir, name), 'test', bypassCooldown);

    // `appsInProgress.add` is the first side effect past the guard chain, so
    // spying on it is the honest "did this get through?" signal. (The runtime
    // is not touched anywhere in handleAppUpdate — asserting on it would have
    // passed for the wrong reason on both branches.)
    let inProgressAdd: jest.SpyInstance;

    beforeEach(() => {
      (platform as any).runtime = { getStatus: jest.fn().mockResolvedValue(undefined) };
      (platform as any).detector = { detect: jest.fn().mockResolvedValue({ type: 'static' }) };
      (platform as any).builder = { build: jest.fn().mockResolvedValue({ success: true }) };
      const inProgress = new Set<string>();
      inProgressAdd = jest.spyOn(inProgress, 'add');
      (platform as any).appsInProgress = inProgress;
    });

    it('refuses an incidental update for a grouped child', async () => {
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });
      // MUST be registered and running, or the '!appState' guard returns first
      // and this test passes even with the group guard deleted (it did — the
      // mutation check caught it).
      states.set('ezsign-frontend', { name: 'ezsign-frontend', group: 'ezsign', status: 'running' });

      await update('ezsign-frontend', false);

      // Bailed before doing anything at all.
      expect(inProgressAdd).not.toHaveBeenCalled();
      expect((platform as any).detector.detect).not.toHaveBeenCalled();
    });

    it('does not refuse an incidental update for a standalone app', async () => {
      configs.set('waitlist', { name: 'waitlist', path: '/x' });
      // Must exist in state, or the "not yet registered" guard returns before
      // the runtime is ever consulted and this asserts nothing.
      states.set('waitlist', { name: 'waitlist', status: 'running' });

      await update('waitlist', false);

      // Got past the guard — proven by reaching the in-progress marker.
      expect(inProgressAdd).toHaveBeenCalledWith('waitlist');
    });

    it('lets an EXPLICIT redeploy of a grouped child through the guard', async () => {
      // bypassCooldown means a human/API asked for it; the API resolves a child
      // redeploy to its container (DROP-065), so this should stay reachable.
      configs.set('ezsign-frontend', { name: 'ezsign-frontend', path: '/x', group: 'ezsign' });
      states.set('ezsign-frontend', {
        name: 'ezsign-frontend',
        group: 'ezsign',
        status: 'running',
      });

      await update('ezsign-frontend', true);

      expect(inProgressAdd).toHaveBeenCalledWith('ezsign-frontend');
    });
  });
});
