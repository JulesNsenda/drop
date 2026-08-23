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
  resolveHttpsEffective,
  ACCESS_GATE_ENFORCEMENT_AVAILABLE,
  type AccessGateContext,
} from './access-gate';

/** The one shape where a gate IS enforceable — every test perturbs one field. */
const ENFORCEABLE: AccessGateContext = {
  isolation: 'docker',
  authEnabled: true,
  httpsEffective: true,
  networkIsolation: 'isolated',
  publicUrl: 'https://dashboard.example.com',
  hostnameCount: 1,
  apiPortUsable: true,
  appNameSafe: true,
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

  it('refuses the monorepo CONTAINER, which serves nothing at all', () => {
    // The container's `group` tag lives in AppState, not AppConfig, so an
    // earlier version read `undefined` here and let an admin gate it: a
    // governance record over an address nobody can reach, while the children
    // holding the data stayed open on the group host.
    const verdict = assessAccessGate({ ...ENFORCEABLE, group: 'ezsign', isGroupContainer: true });
    expect(verdict.enforceable).toBe(false);
    expect(verdict.blockers).toContain('monorepo-group-container');
    // One blocker, not both — they are the same problem described twice.
    expect(verdict.blockers).not.toContain('monorepo-group-child');
  });

  describe('the four ways a gate can BRICK an app rather than protect it', () => {
    // Each of these emits a guard in front of an app that then answers nothing
    // to anyone. That is a worse outcome than no gate, and worse than a refusal
    // — which is why they are blockers rather than warnings.

    it('refuses with no public URL — there is nowhere to send anyone to sign in', () => {
      const verdict = assessAccessGate({ ...ENFORCEABLE, publicUrl: undefined });
      expect(verdict.enforceable).toBe(false);
      expect(verdict.blockers).toContain('no-public-url');
    });

    it('refuses an app routed on more than one hostname', () => {
      // The session cookie is `__Host-` and therefore host-only, while routes
      // are emitted per hostname — a visitor on any secondary hostname would be
      // redirected to the primary and loop forever on the address they asked
      // for.
      const verdict = assessAccessGate({ ...ENFORCEABLE, hostnameCount: 2 });
      expect(verdict.enforceable).toBe(false);
      expect(verdict.blockers).toContain('multi-hostname');
    });

    it('refuses when the API port is unusable', () => {
      // `forward_auth 127.0.0.1:NaN` fails to parse the WHOLE Caddyfile, so
      // this one takes every site on the box down, not just this app.
      const verdict = assessAccessGate({ ...ENFORCEABLE, apiPortUsable: false });
      expect(verdict.enforceable).toBe(false);
      expect(verdict.blockers).toContain('api-port-unusable');
    });

    it('refuses a name that cannot be written into a Caddy directive', () => {
      const verdict = assessAccessGate({ ...ENFORCEABLE, appNameSafe: false });
      expect(verdict.enforceable).toBe(false);
      expect(verdict.blockers).toContain('invalid-app-name');
    });

    it('treats a single hostname and an absent count identically', () => {
      // Callers that predate the field must not start being refused.
      expect(assessAccessGate({ ...ENFORCEABLE, hostnameCount: undefined }).enforceable).toBe(true);
      expect(assessAccessGate({ ...ENFORCEABLE, hostnameCount: 1 }).enforceable).toBe(true);
    });
  });

  it('reports enforcement as UNAVAILABLE in this build', () => {
    // The verdict answers "could this box enforce a gate", which is not the
    // same question as "is anything enforcing one". Until the guard emitter
    // ships, nothing is — and every affirmative signal in the API is gated on
    // this constant so none of them can claim otherwise.
    expect(ACCESS_GATE_ENFORCEMENT_AVAILABLE).toBe(false);
  });

  it('reports EVERY blocker, not just the first', () => {
    const verdict = assessAccessGate({
      isolation: 'none',
      authEnabled: false,
      httpsEffective: false,
      networkIsolation: 'shared',
      group: 'ezsign',
      publicUrl: undefined,
      hostnameCount: 3,
      apiPortUsable: false,
      appNameSafe: false,
    });
    expect(verdict.blockers).toEqual([
      'isolation-not-docker',
      'auth-disabled',
      'no-https',
      'tenant-network-shared',
      'monorepo-group-child',
      'no-public-url',
      'multi-hostname',
      'api-port-unusable',
      'invalid-app-name',
    ]);
    // One sentence per blocker, in the same order — an operator fixing one at
    // a time must not have to rediscover the next on the next attempt.
    expect(verdict.reasons).toHaveLength(9);
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

  it('ignores a tenant-authored TLS opt-out — there is no input for it', () => {
    // It used to take `tlsDisabled`, read from the app's own drop.yaml, which
    // handed the governed party a one-line off switch for the control
    // governing them. The caller drops plaintext hostnames instead.
    expect(
      resolveHttpsEffective(['a.example.com'], {
        enableHttps: true,
        // @ts-expect-error — no such input, deliberately.
        tlsDisabled: true,
        isLocalhost,
      })
    ).toBe(true);
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
