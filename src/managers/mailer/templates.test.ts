import { renderTemplate } from './templates';

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

  describe('invite (unused until Slice C)', () => {
    const vars = {
      appName: 'my-app',
      sharerName: 'alice',
      inviteUrl: 'https://drop.example.com/invite/abc123',
      platformUrl: 'https://drop.example.com',
    };

    it('renders every variable', () => {
      const rendered = renderTemplate('invite', vars);

      expect(rendered.subject).toContain('alice');
      expect(rendered.subject).toContain('my-app');
      expect(rendered.html).toContain('https://drop.example.com/invite/abc123');
      expect(rendered.text).toContain('https://drop.example.com/invite/abc123');
    });

    it('HTML-escapes every variable', () => {
      const rendered = renderTemplate('invite', {
        ...vars,
        sharerName: '<script>alert(1)</script>',
      });

      expect(rendered.html).not.toContain('<script>alert(1)</script>');
      expect(rendered.html).toContain('&lt;script&gt;');
    });

    it('rejects CRLF in a variable', () => {
      expect(() =>
        renderTemplate('invite', { ...vars, inviteUrl: 'https://x\r\nBcc: victim@example.com' })
      ).toThrow(/CR\/LF\/NUL/);
    });
  });
});
