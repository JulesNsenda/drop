import { deriveSiteOrigin } from './site-url';

describe('deriveSiteOrigin', () => {
  it('strips the dashboard label to reach the marketing apex', () => {
    expect(deriveSiteOrigin('https:', 'dashboard.dropkit.sh')).toBe('https://dropkit.sh');
  });

  it('preserves the scheme rather than assuming https', () => {
    expect(deriveSiteOrigin('http:', 'dashboard.example.com')).toBe('http://example.com');
  });

  it('handles a deeper apex than a bare registrable pair', () => {
    expect(deriveSiteOrigin('https:', 'dashboard.eu.example.co.uk')).toBe(
      'https://eu.example.co.uk'
    );
  });

  // The regression this file exists for: every one of these used to render a
  // "Back to home" link pointing at "/", which 301s to /dashboard and bounces
  // a logged-out visitor back to /login.
  it('returns null when the dashboard is not on its own subdomain', () => {
    expect(deriveSiteOrigin('https:', 'dropkit.sh')).toBeNull();
    expect(deriveSiteOrigin('http:', 'localhost')).toBeNull();
    expect(deriveSiteOrigin('http:', '127.0.0.1')).toBeNull();
  });

  it('returns null for dashboard.localhost — stripping it lands on this same platform', () => {
    expect(deriveSiteOrigin('http:', 'dashboard.localhost')).toBeNull();
  });

  // Load-bearing for the security argument: the return value becomes an href,
  // so there must be no input that yields a non-http scheme. A `file:` /
  // `about:blank` context has an empty hostname and must fall out as null
  // rather than composing `javascript:`-style garbage.
  it('returns null for an empty or malformed hostname', () => {
    expect(deriveSiteOrigin('https:', '')).toBeNull();
    expect(deriveSiteOrigin('file:', '')).toBeNull();
    expect(deriveSiteOrigin('about:', 'blank')).toBeNull();
  });

  // Known limitation, pinned so it is a decision rather than a surprise: a
  // split-horizon internal name satisfies the dot test and yields a link to a
  // host that serves nothing. Not fixable client-side — there is no public
  // suffix list in the browser. A dead link is the worst case.
  it('cannot distinguish a split-horizon internal domain from a public one', () => {
    expect(deriveSiteOrigin('http:', 'dashboard.mybox.lan')).toBe('http://mybox.lan');
  });

  it('does not treat a host merely starting with "dashboard" as a subdomain', () => {
    // The trailing dot in the label is what makes this a label match rather
    // than a prefix match — without it this would strip to `s.dropkit.sh`.
    expect(deriveSiteOrigin('https:', 'dashboards.dropkit.sh')).toBeNull();
  });
});
