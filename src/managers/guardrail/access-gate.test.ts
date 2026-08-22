/**
 * The access-gate enforceability rule (DROP-152).
 *
 * A pure function deliberately, so the rule can be pinned here once and the
 * three refusal points (the route, route emission, the boot sweep) share it
 * rather than each re-deriving a slightly different one.
 *
 * The cases that matter are the ones where the gate would be DECORATIVE: a
 * policy is persisted, the dashboard says "gated", and traffic reaches the app
 * anyway. Each blocker below is one such path.
 */

import {
  assessAccessGate,
  describeAccessGateRefusal,
  resolveGateHostnames,
  resolveHttpsEffective,
  type AccessGateContext,
} from './access-gate';

/** The one shape where a gate IS enforceable — every test perturbs one field. */
const ENFORCEABLE: AccessGateContext = {
  isolation: 'docker',
  authEnabled: true,
  httpsEffective: true,
  networkIsolation: 'isolated',
};

describe('assessAccessGate', () => {
  it('permits a gate only on docker isolation + auth + HTTPS + an isolated tenant network', () => {
    const verdict = assessAccessGate(ENFORCEABLE);
    expect(verdict.enforceable).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.reasons).toEqual([]);
  });

  it('refuses outside docker isolation — the app binds the host port itself', () => {
    const verdict = assessAccessGate({ ...ENFORCEABLE, isolation: 'none' });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('isolation-not-docker');
  });

  it('refuses when API auth is disabled — there is no principal to gate on', () => {
    const verdict = assessAccessGate({ ...ENFORCEABLE, authEnabled: false });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('auth-disabled');
  });

  it('refuses without HTTPS — the Secure session cookie would be dropped', () => {
    const verdict = assessAccessGate({ ...ENFORCEABLE, httpsEffective: false });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('no-https');
  });

  it('refuses when drop-net still allows inter-container traffic', () => {
    // Docker isolation is NOT unconditionally sufficient: an in-place upgrade
    // of a box whose drop-net predates enable_icc=false leaves every tenant
    // container able to reach every other tenant's port on the bridge.
    const verdict = assessAccessGate({ ...ENFORCEABLE, networkIsolation: 'shared' });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('tenant-network-shared');
  });

  it('does NOT refuse on an unknown tenant-network state', () => {
    // 'unknown' is the normal state before the first container starts, so
    // refusing on it would refuse every correctly configured box at boot.
    const verdict = assessAccessGate({ ...ENFORCEABLE, networkIsolation: 'unknown' });
    expect(verdict.enforceable).toBe(true);
  });

  it('refuses a monorepo group child — siblings share the hostname', () => {
    const verdict = assessAccessGate({ ...ENFORCEABLE, group: 'ezsign' });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('monorepo-group-child');
  });

  it('reports EVERY blocker, not just the first', () => {
    const verdict = assessAccessGate({
      isolation: 'none',
      authEnabled: false,
      httpsEffective: false,
      networkIsolation: 'shared',
      group: 'ezsign',
    });
    expect(verdict.blockers).toEqual([
      'isolation-not-docker',
      'auth-disabled',
      'no-https',
      'tenant-network-shared',
      'monorepo-group-child',
    ]);
    // One sentence per blocker, in the same order — an operator fixing one at
    // a time must not have to rediscover the next on the next attempt.
    expect(verdict.reasons).toHaveLength(5);
    expect(verdict.reasons.every(r => r.length > 0)).toBe(true);
  });

  it('names the app and every reason in the refusal message', () => {
    const verdict = assessAccessGate({ ...ENFORCEABLE, isolation: 'none', authEnabled: false });
    const message = describeAccessGateRefusal('myapp', verdict);
    expect(message).toContain("'myapp'");
    expect(message).toContain('(1)');
    expect(message).toContain('(2)');
  });
});

describe('resolveGateHostnames', () => {
  it('uses the explicit domains when the app has any', () => {
    expect(resolveGateHostnames('myapp', ['a.example.com', 'b.example.com'], 'example.com')).toEqual(
      ['a.example.com', 'b.example.com']
    );
  });

  it('falls back to <name>.<suffix> when it has none', () => {
    expect(resolveGateHostnames('myapp', undefined, 'example.com')).toEqual(['myapp.example.com']);
    expect(resolveGateHostnames('myapp', [], 'example.com')).toEqual(['myapp.example.com']);
  });

  it('falls back to localhost when no suffix is configured', () => {
    expect(resolveGateHostnames('myapp', undefined, '')).toEqual(['myapp.localhost']);
  });
});

describe('resolveHttpsEffective', () => {
  const isLocalhost = (h: string) => h === 'localhost' || h.endsWith('.localhost');

  it('is true only when every hostname is HTTPS', () => {
    expect(
      resolveHttpsEffective(['a.example.com', 'b.example.com'], { enableHttps: true, isLocalhost })
    ).toBe(true);
  });

  it('is false when ANY hostname is a localhost domain', () => {
    // Each `domains:` entry gets its own route, so a user authenticated on one
    // is not authenticated on another — one plaintext entry breaks the gate.
    expect(
      resolveHttpsEffective(['a.example.com', 'dev.localhost'], { enableHttps: true, isLocalhost })
    ).toBe(false);
  });

  it('is false when the app disabled TLS in its own drop.yaml', () => {
    expect(
      resolveHttpsEffective(['a.example.com'], {
        enableHttps: true,
        tlsDisabled: true,
        isLocalhost,
      })
    ).toBe(false);
  });

  it('is false when the platform has HTTPS off', () => {
    expect(resolveHttpsEffective(['a.example.com'], { enableHttps: false, isLocalhost })).toBe(
      false
    );
  });

  it('is false for an empty hostname list rather than vacuously true', () => {
    expect(resolveHttpsEffective([], { enableHttps: true, isLocalhost })).toBe(false);
  });
});
