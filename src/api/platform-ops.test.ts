/**
 * Set/get/reset semantics for the platform-ops singleton.
 *
 * See platform-ops.ts's own header for why the seam exists (routes can't
 * import DropPlatform directly — circular). This just pins the module-level
 * state machine so a future refactor can't silently break the wiring.
 */

import { setPlatformOps, getPlatformOps, resetPlatformOps, PlatformOps } from './platform-ops';
// The shared stub rather than four hand-rolled literals: this suite is about
// the singleton's state machine, not about any op's shape, and the copies it
// used to carry each needed a new field every time PlatformOps grew.
import { makePlatformOpsStub } from './__testutils__/platform-ops';

describe('platform-ops singleton', () => {
  afterEach(() => {
    resetPlatformOps();
  });

  it('returns null before anything is wired', () => {
    expect(getPlatformOps()).toBeNull();
  });

  it('get returns the exact ops object passed to set', () => {
    const ops: PlatformOps = makePlatformOpsStub();
    setPlatformOps(ops);
    expect(getPlatformOps()).toBe(ops);
  });

  it('reset clears the wired ops back to null', () => {
    setPlatformOps(makePlatformOpsStub());
    resetPlatformOps();
    expect(getPlatformOps()).toBeNull();
  });

  it('setting twice keeps the latest ops', () => {
    const first: PlatformOps = makePlatformOpsStub();
    const second: PlatformOps = makePlatformOpsStub();
    setPlatformOps(first);
    setPlatformOps(second);
    expect(getPlatformOps()).toBe(second);
    expect(getPlatformOps()).not.toBe(first);
  });
});
