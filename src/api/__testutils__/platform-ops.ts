/**
 * Shared `PlatformOps` test double.
 *
 * Every route test that stubs out the platform-ops seam (`platform-ops.ts`)
 * used to hand-roll its own copy of this same 8-field object. Growing the
 * interface for DROP-151 Phase 3 (`getServiceIntent`, `attachService`,
 * `detachService`) forced a +2-line edit into every one of those copies —
 * and a copy that drifts (e.g. a bare `jest.fn()` resolving to `undefined`
 * where a caller expects a typed success shape) makes a test pass for the
 * wrong reason instead of failing loudly. One canonical stub, overridden per
 * test via `overrides`, is what those copies all meant to be.
 *
 * Defaults resolve successfully wherever there is a real shape to resolve
 * to. `restartApp` is the one exception — its `AppProcessInfo` result is
 * asserted on directly by some suites (pid/port/status), so a shared
 * `pid: 1`-style default would be an invented value nobody chose; those
 * suites pass their own `restartApp` override (or wrap this stub in a local
 * `makeOps` that bakes one in) rather than the other way round.
 */

import type { PlatformOps, AttachServiceResult, DetachServiceResult } from '../platform-ops';

export function makePlatformOpsStub(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    attachService: jest.fn().mockResolvedValue({
      attached: true,
      envVarNames: [],
    } satisfies AttachServiceResult),
    detachService: jest.fn().mockResolvedValue({
      detached: true,
      deprovisioned: true,
      restart: 'restarted',
    } satisfies DetachServiceResult),
    getServiceIntent: jest.fn().mockReturnValue(undefined),
    isAppInProgress: jest.fn().mockReturnValue(false),
    promoteApp: jest.fn().mockResolvedValue(undefined),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
