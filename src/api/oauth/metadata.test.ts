/**
 * Unit tests for OAuth discovery metadata (PRD-041).
 *
 * Pure-function tests only — env reading (`getPublicUrl()` in
 * `../runtime-config`) is covered separately, not here.
 */

import {
  canonicalizeUrl,
  getMcpResourceUrl,
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
} from './metadata';

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM')).toBe('https://example.com');
  });

  it('drops the default port for https and http', () => {
    expect(canonicalizeUrl('https://example.com:443')).toBe('https://example.com');
    expect(canonicalizeUrl('http://example.com:80')).toBe('http://example.com');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizeUrl('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('strips a trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('strips query and fragment', () => {
    expect(canonicalizeUrl('https://example.com/?foo=bar#frag')).toBe('https://example.com');
  });

  it('preserves a non-empty path', () => {
    expect(canonicalizeUrl('https://example.com/api/v1/mcp')).toBe('https://example.com/api/v1/mcp');
  });
});

describe('getMcpResourceUrl', () => {
  it('appends the MCP path to the canonicalized public URL', () => {
    expect(getMcpResourceUrl('https://example.com')).toBe('https://example.com/api/v1/mcp');
  });

  it('collapses a trailing slash, default port, and uppercase host to the same resource URL', () => {
    const expected = 'https://example.com/api/v1/mcp';
    expect(getMcpResourceUrl('https://example.com/')).toBe(expected);
    expect(getMcpResourceUrl('https://example.com:443')).toBe(expected);
    expect(getMcpResourceUrl('https://example.com:443/')).toBe(expected);
    expect(getMcpResourceUrl('HTTPS://EXAMPLE.COM')).toBe(expected);
  });

  it('never has a trailing slash', () => {
    expect(getMcpResourceUrl('https://example.com')).not.toMatch(/\/$/);
  });
});

describe('buildProtectedResourceMetadata', () => {
  it('returns the exact RFC 9728 document shape', () => {
    expect(buildProtectedResourceMetadata('https://example.com')).toEqual({
      resource: 'https://example.com/api/v1/mcp',
      authorization_servers: ['https://example.com'],
    });
  });

  it('the resource is the issuer plus the /api/v1/mcp suffix, never equal to it', () => {
    const doc = buildProtectedResourceMetadata('https://example.com') as {
      resource: string;
      authorization_servers: string[];
    };
    const issuer = doc.authorization_servers[0];
    expect(doc.resource).toBe(`${issuer}/api/v1/mcp`);
    expect(doc.resource).not.toBe(issuer);
  });

  it('normalizes a trailing-slash public URL the same as a bare one', () => {
    expect(buildProtectedResourceMetadata('https://example.com/')).toEqual(
      buildProtectedResourceMetadata('https://example.com')
    );
  });
});

describe('buildAuthServerMetadata', () => {
  it('returns the exact RFC 8414 document shape', () => {
    expect(buildAuthServerMetadata('https://example.com')).toEqual({
      issuer: 'https://example.com',
      authorization_endpoint: 'https://example.com/api/v1/oauth/authorize',
      token_endpoint: 'https://example.com/api/v1/oauth/token',
      revocation_endpoint: 'https://example.com/api/v1/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['offline_access'],
    });
  });

  it('the revocation_endpoint is derived the same way as authorization/token (same issuer, /oauth/revoke suffix)', () => {
    const doc = buildAuthServerMetadata('https://example.com/') as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      revocation_endpoint: string;
    };
    expect(doc.revocation_endpoint).toBe(`${doc.issuer}/api/v1/oauth/revoke`);
    expect(doc.revocation_endpoint.replace('/revoke', '')).toBe(
      doc.authorization_endpoint.replace('/authorize', '')
    );
    expect(doc.revocation_endpoint.replace('/revoke', '')).toBe(doc.token_endpoint.replace('/token', ''));
  });

  it('never includes a registration_endpoint (dynamic client registration is cut)', () => {
    const doc = buildAuthServerMetadata('https://example.com') as Record<string, unknown>;
    expect(doc.registration_endpoint).toBeUndefined();
    expect(Object.keys(doc)).not.toContain('registration_endpoint');
  });

  it('the issuer is the canonicalized base URL, distinct from the resource URL', () => {
    const doc = buildAuthServerMetadata('https://example.com/') as { issuer: string };
    const resource = getMcpResourceUrl('https://example.com/');
    expect(doc.issuer).toBe('https://example.com');
    expect(doc.issuer).not.toBe(resource);
  });
});
