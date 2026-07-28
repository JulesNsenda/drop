/**
 * Per-app OAuth resource resolution (Step 11, PR 2).
 *
 * SEC-1 in one sentence: an audience must resolve to exactly ONE target, and
 * comparison must stay exact. The rejected design relaxed audience checking
 * into a lookup over a set — which breaks tokens across resources in both
 * directions (a tenant-audienced token verifying at DROP's control plane, and
 * a DROP token replayable against a tenant).
 */

import { resolveOAuthResource, audienceFor, getAppMcpResourceUrl } from './app-resources';

const DROP = 'https://drop.example.com/api/v1/mcp';

const apps = [
  { appName: 'alpha', resource: 'https://alpha.example.com/mcp' },
  { appName: 'beta', resource: 'https://beta.example.com/mcp' },
];

describe('getAppMcpResourceUrl', () => {
  it('composes and canonicalizes', () => {
    expect(getAppMcpResourceUrl('https://Alpha.Example.com', '/mcp')).toBe(
      'https://alpha.example.com/mcp'
    );
  });

  it('drops a default port so two spellings of one resource cannot diverge', () => {
    // Otherwise `https://a.example.com:443/mcp` and `https://a.example.com/mcp`
    // would be different audiences for the same endpoint, and a token minted
    // under one would silently fail against the other.
    expect(getAppMcpResourceUrl('https://a.example.com:443', '/mcp')).toBe(
      'https://a.example.com/mcp'
    );
  });
});

describe('resolveOAuthResource', () => {
  it('defaults to DROP when no resource is named', () => {
    expect(resolveOAuthResource(undefined, DROP, apps)).toEqual({ kind: 'drop' });
  });

  it('resolves DROP’s own resource', () => {
    expect(resolveOAuthResource(DROP, DROP, apps)).toEqual({ kind: 'drop' });
  });

  it('resolves an app resource to that app', () => {
    expect(resolveOAuthResource('https://alpha.example.com/mcp', DROP, apps)).toEqual({
      kind: 'app',
      appName: 'alpha',
      resource: 'https://alpha.example.com/mcp',
    });
  });

  it('canonicalizes before comparing', () => {
    expect(resolveOAuthResource('https://ALPHA.example.com:443/mcp', DROP, apps)).toMatchObject({
      appName: 'alpha',
    });
  });

  it('REFUSES an unknown host', () => {
    // A tenant-controlled subdomain must not become a registrable OAuth
    // resource merely by being named on the consent screen.
    expect(resolveOAuthResource('https://evil.example.com/mcp', DROP, apps)).toBeNull();
  });

  it('REFUSES a path that merely shares a prefix with a known resource', () => {
    // `===`, never startsWith — the same rule the agent-scope grammar follows.
    expect(resolveOAuthResource('https://alpha.example.com/mcp-admin', DROP, apps)).toBeNull();
    expect(resolveOAuthResource('https://alpha.example.com/mcp/sub', DROP, apps)).toBeNull();
  });

  it('REFUSES a host that merely shares a prefix', () => {
    expect(resolveOAuthResource('https://alpha.example.com.evil.test/mcp', DROP, apps)).toBeNull();
  });

  it('REFUSES an unparseable resource', () => {
    expect(resolveOAuthResource('not a url', DROP, apps)).toBeNull();
  });

  it('REFUSES an ambiguous resource rather than picking one', () => {
    // Two apps claiming one identifier makes the target undecidable; picking
    // would hand a token for whichever happened to sort first.
    const duplicated = [
      { appName: 'alpha', resource: 'https://same.example.com/mcp' },
      { appName: 'beta', resource: 'https://same.example.com/mcp' },
    ];
    expect(resolveOAuthResource('https://same.example.com/mcp', DROP, duplicated)).toBeNull();
  });

  it('resolves nothing to an app when the app list is empty', () => {
    expect(resolveOAuthResource('https://alpha.example.com/mcp', DROP, [])).toBeNull();
  });
});

describe('audienceFor', () => {
  it('gives DROP’s resource for the drop target and the app’s for an app', () => {
    expect(audienceFor({ kind: 'drop' }, DROP)).toBe(DROP);
    expect(
      audienceFor({ kind: 'app', appName: 'alpha', resource: 'https://alpha.example.com/mcp' }, DROP)
    ).toBe('https://alpha.example.com/mcp');
  });
});
