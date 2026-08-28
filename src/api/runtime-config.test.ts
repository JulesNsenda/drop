/**
 * Unit tests for the DROP-153 access-gate runtime-config accessor
 * (`isAccessGateEnabled`).
 *
 * `runtimeConfig` is module-level mutable state and `setApiRuntimeConfig` has
 * no way to "clear" a field back to unset (see its own comment in
 * runtime-config.ts) — every other test in this repo that calls it relies on
 * declaration order within one file. The unset case here does NOT rely on
 * that: it uses `jest.resetModules()` + a fresh `require()` so it reads a
 * module nobody has called `setApiRuntimeConfig` on yet, regardless of what
 * runs before or after it in this file.
 *
 * There is deliberately no `isAppSharingEnabled` here — that toggle is read
 * live from the settings manager so an admin's runtime change takes effect
 * without a platform restart. See runtime-config.ts's comment where the
 * accessor would otherwise have been.
 */

type RuntimeConfigModule = typeof import('./runtime-config');

function freshModule(): RuntimeConfigModule {
  let mod: RuntimeConfigModule;
  jest.isolateModules(() => {
    mod = require('./runtime-config') as RuntimeConfigModule;
  });
  return mod!;
}

describe('runtime-config: accessGateEnabled', () => {
  // Fail-closed for a SECURITY control means "keep enforcing", which is the
  // OPPOSITE direction to a product toggle. The /verify hop admits on false;
  // if an unwired flag read as "off", every visitor would be admitted to every
  // gated app while the Caddy guards stayed installed.
  it('fails closed (ENFORCING) when setApiRuntimeConfig was never called', () => {
    const fresh = freshModule();
    expect(fresh.isAccessGateEnabled()).toBe(true);
  });

  it('an explicit false is a real value, distinct from "unset"', () => {
    const fresh = freshModule();
    expect(fresh.isAccessGateEnabled()).toBe(true);
    fresh.setApiRuntimeConfig({ accessGateEnabled: false });
    expect(fresh.isAccessGateEnabled()).toBe(false);
  });

  it('an explicit true keeps the gate enforcing', () => {
    const fresh = freshModule();
    fresh.setApiRuntimeConfig({ accessGateEnabled: true });
    expect(fresh.isAccessGateEnabled()).toBe(true);
  });

  // setApiRuntimeConfig only assigns fields that are `!== undefined`, so an
  // unrelated later call must not silently re-arm a gate the operator disabled.
  it('a later setApiRuntimeConfig({}) does not reset an explicit false', () => {
    const fresh = freshModule();
    fresh.setApiRuntimeConfig({ accessGateEnabled: false });
    fresh.setApiRuntimeConfig({ domainSuffix: 'example.com' });
    expect(fresh.isAccessGateEnabled()).toBe(false);
  });
});
