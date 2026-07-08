/**
 * Set/get/reset semantics for the platform-ops singleton.
 *
 * See platform-ops.ts's own header for why the seam exists (routes can't
 * import DropPlatform directly — circular). This just pins the module-level
 * state machine so a future refactor can't silently break the wiring.
 */

import { setPlatformOps, getPlatformOps, resetPlatformOps, PlatformOps } from './platform-ops';

describe('platform-ops singleton', () => {
  afterEach(() => {
    resetPlatformOps();
  });

  it('returns null before anything is wired', () => {
    expect(getPlatformOps()).toBeNull();
  });

  it('get returns the exact ops object passed to set', () => {
    const ops: PlatformOps = { restartApp: jest.fn() };
    setPlatformOps(ops);
    expect(getPlatformOps()).toBe(ops);
  });

  it('reset clears the wired ops back to null', () => {
    setPlatformOps({ restartApp: jest.fn() });
    resetPlatformOps();
    expect(getPlatformOps()).toBeNull();
  });

  it('setting twice keeps the latest ops', () => {
    const first: PlatformOps = { restartApp: jest.fn() };
    const second: PlatformOps = { restartApp: jest.fn() };
    setPlatformOps(first);
    setPlatformOps(second);
    expect(getPlatformOps()).toBe(second);
    expect(getPlatformOps()).not.toBe(first);
  });
});
