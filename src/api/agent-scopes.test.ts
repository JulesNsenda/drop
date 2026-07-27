/**
 * Agent-token scope grammar (SEC-10).
 *
 * Two specific holes a plausible implementation leaves, and each is a real
 * privilege escalation rather than a nicety:
 *
 *  1. MINT TIME — not checking that the REQUESTER already has access to every
 *     app they name. Without it any authenticated user mints
 *     `app:<victim-app>:deploy` for themselves.
 *  2. CHECK TIME — comparing with `startsWith` instead of `===`. That hands
 *     the holder of `app:foo:deploy` authority over `foobar`.
 */

import {
  parseAgentScope,
  normalizeAgentScope,
  scopesAllow,
  scopesAllowCreate,
  assertMintable,
  SCOPE_APPS_CREATE,
} from './agent-scopes';

const ALLOW_ALL = () => true;
const ALLOW_NONE = () => false;

describe('parseAgentScope', () => {
  it('accepts the two app verbs', () => {
    expect(parseAgentScope('app:myapp:deploy')).toEqual({
      kind: 'app',
      appName: 'myapp',
      verb: 'deploy',
    });
    expect(parseAgentScope('app:myapp:read')?.verb).toBe('read');
  });

  it('preserves the app name EXACTLY, case included', () => {
    // Names are case-sensitive here because the space they address is:
    // APP_NAME_RE permits upper case and AppStateManager keys a plain Map.
    // Folding disagreed with that in both directions — a scope for 'myapp'
    // matched a different app named 'MyApp', while minting 'app:MyApp:deploy'
    // folded to 'myapp', missed the lookup, and failed as "not yours" for an
    // app the requester owned.
    expect(parseAgentScope('app:MyApp:deploy')?.appName).toBe('MyApp');
  });

  it('requires EXACTLY three parts', () => {
    // Two would be ambiguous with `apps:create`; four means something carried
    // a delimiter it should not have.
    expect(parseAgentScope('app:myapp')).toBeNull();
    expect(parseAgentScope('app:myapp:deploy:extra')).toBeNull();
    expect(parseAgentScope('myapp:deploy')).toBeNull();
  });

  it('rejects an unknown verb', () => {
    expect(parseAgentScope('app:myapp:delete')).toBeNull();
    expect(parseAgentScope('app:myapp:*')).toBeNull();
    expect(parseAgentScope('app:myapp:')).toBeNull();
  });

  it('rejects an app name that is not a valid app name', () => {
    expect(parseAgentScope('app:../etc/passwd:deploy')).toBeNull();
    expect(parseAgentScope('app:my app:deploy')).toBeNull();
    expect(parseAgentScope('app::deploy')).toBeNull();
    expect(parseAgentScope('app:*:deploy')).toBeNull();
  });

  it('does not treat apps:create as an app scope', () => {
    expect(parseAgentScope(SCOPE_APPS_CREATE)).toBeNull();
    expect(normalizeAgentScope(SCOPE_APPS_CREATE)).toBe(SCOPE_APPS_CREATE);
  });
});

describe('scopesAllow', () => {
  it('grants the exact app and verb', () => {
    expect(scopesAllow(['app:myapp:deploy'], 'myapp', 'deploy')).toBe(true);
  });

  it('does NOT grant a name that merely shares a prefix', () => {
    // THE SEC-10 check-time hole. A `startsWith('app:' + name)` implementation
    // hands `app:foo:deploy` authority over every app whose name begins with
    // 'foo'.
    const scopes = ['app:foo:deploy'];

    expect(scopesAllow(scopes, 'foobar', 'deploy')).toBe(false);
    expect(scopesAllow(scopes, 'foo-staging', 'deploy')).toBe(false);
    expect(scopesAllow(scopes, 'foo2', 'deploy')).toBe(false);
    // ...and the other direction, in case someone compares the wrong way round.
    expect(scopesAllow(['app:foobar:deploy'], 'foo', 'deploy')).toBe(false);
  });

  it('does not let one verb stand in for another', () => {
    expect(scopesAllow(['app:myapp:read'], 'myapp', 'deploy')).toBe(false);
    expect(scopesAllow(['app:myapp:deploy'], 'myapp', 'read')).toBe(false);
  });

  it('does NOT match a differently-cased app name', () => {
    // 'MyApp' and 'myapp' are two different apps as far as the state manager
    // is concerned, so a scope for one must not reach the other.
    expect(scopesAllow(['app:MyApp:deploy'], 'myapp', 'deploy')).toBe(false);
    expect(scopesAllow(['app:myapp:deploy'], 'MyApp', 'deploy')).toBe(false);
    expect(scopesAllow(['app:MyApp:deploy'], 'MyApp', 'deploy')).toBe(true);
  });

  it('ignores a malformed scope rather than trusting it', () => {
    expect(scopesAllow(['app:myapp:deploy:extra'], 'myapp', 'deploy')).toBe(false);
    expect(scopesAllow(['*'], 'myapp', 'deploy')).toBe(false);
    expect(scopesAllow(['app:*:deploy'], 'myapp', 'deploy')).toBe(false);
  });

  it('is false for no scopes at all', () => {
    expect(scopesAllow(undefined, 'myapp', 'deploy')).toBe(false);
    expect(scopesAllow([], 'myapp', 'deploy')).toBe(false);
  });

  it('does not confuse apps:create with an app grant', () => {
    expect(scopesAllow([SCOPE_APPS_CREATE], 'myapp', 'deploy')).toBe(false);
    expect(scopesAllowCreate([SCOPE_APPS_CREATE])).toBe(true);
    expect(scopesAllowCreate(['app:myapp:deploy'])).toBe(false);
  });
});

describe('assertMintable', () => {
  it('REFUSES to grant an app the requester cannot access', () => {
    // THE SEC-10 mint-time hole. Without this any authenticated user mints
    // `app:<victim-app>:deploy` and deploys over someone else's app.
    const result = assertMintable(['app:victim:deploy'], ALLOW_NONE);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('victim');
  });

  it('refuses the whole request if ANY named app is inaccessible', () => {
    // All-or-nothing. Silently dropping the one they may not have would mint a
    // token that looks like it was granted what was asked for.
    const canAccess = (name: string) => name === 'mine';
    const result = assertMintable(['app:mine:deploy', 'app:theirs:deploy'], canAccess);

    expect(result.ok).toBe(false);
  });

  it('allows apps:create without naming an app', () => {
    // It cannot name one — the app does not exist yet — so there is nothing to
    // ownership-check.
    expect(assertMintable([SCOPE_APPS_CREATE], ALLOW_NONE).ok).toBe(true);
  });

  it('de-duplicates identical grants', () => {
    // One grant repeated must not become two stored scopes, or a revocation
    // that removes one leaves the other.
    const result = assertMintable(['app:myapp:deploy', 'app:myapp:deploy'], ALLOW_ALL);

    expect(result.ok).toBe(true);
    expect(result.normalized).toEqual(['app:myapp:deploy']);
  });

  it('keeps two differently-cased names as DISTINCT grants', () => {
    // They address different apps, so collapsing them would silently grant one
    // of them authority it was never given.
    const result = assertMintable(['app:MyApp:deploy', 'app:myapp:deploy'], ALLOW_ALL);

    expect(result.normalized).toEqual(['app:MyApp:deploy', 'app:myapp:deploy']);
  });

  it('rejects an empty or non-array request', () => {
    expect(assertMintable([], ALLOW_ALL).ok).toBe(false);
    expect(assertMintable(undefined, ALLOW_ALL).ok).toBe(false);
    expect(assertMintable('app:myapp:deploy', ALLOW_ALL).ok).toBe(false);
  });

  it('rejects a non-string entry rather than coercing it', () => {
    expect(assertMintable([{ toString: () => 'app:myapp:deploy' }], ALLOW_ALL).ok).toBe(false);
    expect(assertMintable([null], ALLOW_ALL).ok).toBe(false);
  });

  it('rejects an absurd number of scopes', () => {
    const many = Array.from({ length: 100 }, (_, i) => `app:app${i}:deploy`);
    expect(assertMintable(many, ALLOW_ALL).ok).toBe(false);
  });

  it('rejects a malformed scope even when the requester owns everything', () => {
    expect(assertMintable(['app:myapp:sudo'], ALLOW_ALL).ok).toBe(false);
    expect(assertMintable(['admin'], ALLOW_ALL).ok).toBe(false);
    expect(assertMintable(['app:../x:deploy'], ALLOW_ALL).ok).toBe(false);
  });
});
