/**
 * Shared attach/detach test fixtures (DROP-151 Phases 2-3).
 *
 * platform.attach-service.test.ts and platform.detach-service.test.ts used to
 * each hand-roll a near-verbatim copy of these three. `stubAppConfigService`
 * in particular encodes a REAL contract — `setServiceIntent` resolving null
 * when no config exists, the same null-means-"no config to write into" shape
 * the real `AppConfigService.setServiceIntent` has — so two copies meant a
 * future contract change could get fixed in one suite and silently left
 * stale in the other.
 */
import type { DropPlatform } from '../platform';
import type { AppState } from '../../managers/app/state-manager';
import type { AppConfig } from '../../managers/app/app-config';

/** A minimal, valid AppConfig for `appName`, with any fields overridden. */
export function baseConfig(appName: string, overrides?: Partial<AppConfig>): AppConfig {
  return {
    name: appName,
    type: 'nodejs',
    createdAt: new Date().toISOString(),
    path: `/apps/${appName}`,
    ...overrides,
  };
}

/** A minimal, valid AppState for `appName` — running, owned by 'user-1' — with any fields overridden. */
export function baseState(appName: string, overrides?: Partial<AppState>): AppState {
  return {
    name: appName,
    type: 'nodejs',
    status: 'running',
    path: `/apps/${appName}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId: 'user-1',
    ...overrides,
  };
}

/**
 * Stub AppConfigService the way attachService/detachService read/write it.
 * Returns the setServiceIntent mock. Defaults to resolving the (possibly-
 * updated) config on success and null when no config was given — the same
 * null-means-"no config to write into" contract the real
 * AppConfigService.setServiceIntent has: both methods check this return
 * value, so a stub resolving `undefined` regardless of `config` would
 * falsely refuse every success-path test.
 */
export function stubAppConfigService(platform: DropPlatform, config: AppConfig | undefined): jest.Mock {
  const setServiceIntent = jest.fn().mockResolvedValue(config ? { ...config } : null);
  (platform as any).appConfigService = {
    getConfig: jest.fn().mockReturnValue(config),
    setServiceIntent,
  };
  return setServiceIntent;
}
