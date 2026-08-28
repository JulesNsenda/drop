import { renderTemplate } from './templates';

/** Built at runtime rather than written as an escape, so no editor or formatter can normalize it away. */
const CRLF = String.fromCharCode(13, 10);

describe('renderTemplate', () => {
  describe('share-notification', () => {
    const vars = {
      appName: 'my-app',
      sharerName: 'alice',
      appUrl: 'https://my-app.example.com',
      platformUrl: 'https://drop.example.com',
    };

    it('interpolates every variable into subject/html/text', () => {
      const rendered = renderTemplate('share-notification', vars);

      expect(rendered.subject).toContain('alice');
      expect(rendered.subject).toContain('my-app');
      expect(rendered.html).toContain('my-app');
      expect(rendered.html).toContain('alice');
      expect(rendered.html).toContain('https://my-app.example.com');
      expect(rendered.html).toContain('https://drop.example.com');
      expect(rendered.text).toContain('my-app');
      expect(rendered.text).toContain('alice');
    });

    it('HTML-escapes every variable at render time regardless of upstream grammar', () => {
      const rendered = renderTemplate('share-notification', {
        appName: '<script>alert(1)</script>',
        sharerName: '<img src=x onerror=alert(1)>',
        appUrl: 'https://example.com/?x="><svg/onload=alert(1)>',
        platformUrl: 'https://drop.example.com',
      });

      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).not.toContain('<img src=x');
      expect(rendered.html).not.toContain('"><svg');
      expect(rendered.html).toContain('&lt;script&gt;');
      expect(rendered.html).toContain('&lt;img');
    });

    it('rejects CR in a variable', () => {
      expect(() =>
        renderTemplate('share-notification', { ...vars, appName: 'app\rname' })
      ).toThrow(/CR\/LF\/NUL/);
    });

    it('rejects LF in a variable', () => {
      expect(() =>
        renderTemplate('share-notification', { ...vars, sharerName: 'alice\nBcc: victim@example.com' })
      ).toThrow(/CR\/LF\/NUL/);
    });

    it('rejects NUL in a variable', () => {
      expect(() => renderTemplate('share-notification', { ...vars, appUrl: 'https://x\0y' })).toThrow(
        /CR\/LF\/NUL/
      );
    });

    it('rejects CRLF header-injection payloads', () => {
      expect(() =>
        renderTemplate('share-notification', {
          ...vars,
          appName: 'app\r\nBcc: victim@example.com',
        })
      ).toThrow(/CR\/LF\/NUL/);
    });
  });

  describe('guest-invite', () => {
    const vars = {
      appName: 'invoices',
      inviterName: 'alice',
      inviteUrl: 'https://drop.example.com/api/v1/app-access/invite/abc#s3cr3t',
      platformUrl: 'https://drop.example.com',
      expiresInHours: 24,
    };

    it('interpolates every variable into subject/html/text', () => {
      const rendered = renderTemplate('guest-invite', vars);

      expect(rendered.subject).toContain('alice');
      expect(rendered.subject).toContain('invoices');
      expect(rendered.html).toContain(vars.inviteUrl);
      expect(rendered.html).toContain('24 hours');
      expect(rendered.text).toContain(vars.inviteUrl);
      expect(rendered.text).toContain('24 hours');
    });

    it('REFUSES an inviteUrl on any origin other than the platform', () => {
      // The §C rule, enforced at the message boundary. The invite link is the
      // one URL in DROP's outbound mail carrying a live secret, and the whole
      // point of the revised hop chain is that it lands on the operator's own
      // origin. A caller that builds it from anything tenant-authored — the
      // app's own drop.yaml `domains` / `customDomain` — fails HERE rather
      // than shipping a phishing-grade link signed by the operator's relay.
      expect(() =>
        renderTemplate('guest-invite', {
          ...vars,
          inviteUrl: 'https://invoices.tenant-chosen.example/api/v1/app-access/invite/abc#s3cr3t',
        })
      ).toThrow(/not the platform origin/);
    });

    it('refuses a same-HOST, different-scheme or different-port inviteUrl', () => {
      // Origin, not hostname: http://drop.example.com is a different origin
      // from https://drop.example.com, and a cookie set by the §C chain on one
      // is not the cookie the other reads.
      expect(() =>
        renderTemplate('guest-invite', {
          ...vars,
          inviteUrl: 'http://drop.example.com/api/v1/app-access/invite/abc#s3cr3t',
        })
      ).toThrow(/not the platform origin/);
      expect(() =>
        renderTemplate('guest-invite', {
          ...vars,
          inviteUrl: 'https://drop.example.com:8443/api/v1/app-access/invite/abc#s3cr3t',
        })
      ).toThrow(/not the platform origin/);
    });

    it('refuses a relative or unparseable inviteUrl rather than rendering it', () => {
      expect(() =>
        renderTemplate('guest-invite', { ...vars, inviteUrl: '/api/v1/app-access/invite/abc#s' })
      ).toThrow(/absolute URLs/);
    });

    it('contains no URL outside the platform origin', () => {
      // The property, asserted as a property rather than as a search for one
      // known-bad string: EVERY absolute URL in the message must be on the
      // operator's own origin. `GuestInviteVars` has no `appUrl` field at all,
      // so this holds structurally today — pinned because the failure mode is
      // someone later "helpfully" adding a link to the app itself, which is
      // exactly the tenant-controlled domain §C removed from mail.
      const rendered = renderTemplate('guest-invite', vars);
      const urls = [
        ...(rendered.html.match(/https?:\/\/[^\s"'<>]+/g) ?? []),
        ...(rendered.text.match(/https?:\/\/[^\s"'<>]+/g) ?? []),
      ];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        // Trailing sentence punctuation is part of the prose, not the URL.
        expect(new URL(url.replace(/[.,)]+$/, '')).origin).toBe('https://drop.example.com');
      }
    });

    it('HTML-escapes every variable at render time', () => {
      const rendered = renderTemplate('guest-invite', {
        ...vars,
        appName: '<script>alert(1)</script>',
        inviterName: '<img src=x onerror=alert(1)>',
      });

      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).not.toContain('<img src=x');
      expect(rendered.html).toContain('&lt;script&gt;');
    });

    it('rejects CRLF in a variable', () => {
      expect(() =>
        renderTemplate('guest-invite', { ...vars, inviterName: 'alice' + CRLF + 'Bcc: victim@example.com' })
      ).toThrow(/CR\/LF\/NUL/);
    });

    it('rejects a non-finite or non-positive expiry rather than printing nonsense', () => {
      // A number cannot inject anything, but "expires in NaN hours" is a
      // message sent to a stranger who has no other context for it.
      expect(() => renderTemplate('guest-invite', { ...vars, expiresInHours: NaN })).toThrow(
        /expiresInHours/
      );
      expect(() => renderTemplate('guest-invite', { ...vars, expiresInHours: 0 })).toThrow(
        /expiresInHours/
      );
    });
  });

  describe('test', () => {
    it('renders with the platform URL', () => {
      const rendered = renderTemplate('test', { platformUrl: 'https://drop.example.com' });

      expect(rendered.subject).toBe('DROP test email');
      expect(rendered.html).toContain('https://drop.example.com');
      expect(rendered.text).toContain('https://drop.example.com');
    });

    it('HTML-escapes the platform URL', () => {
      const rendered = renderTemplate('test', {
        platformUrl: 'https://example.com/"><script>alert(1)</script>',
      });

      expect(rendered.html).not.toContain('<script>');
    });

    it('rejects CRLF in the platform URL', () => {
      expect(() => renderTemplate('test', { platformUrl: 'https://x\r\ny' })).toThrow(/CR\/LF\/NUL/);
    });
  });
});
