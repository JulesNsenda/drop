import nodemailer from 'nodemailer';
import { getSettingsManager } from '../settings/settings-manager';
import { getMailCredentialStore } from './mail-credential';
import { sendTemplatedMail, SEND_DEADLINE_MS } from './mailer';
import type { MailSettings } from '../settings/settings-manager';

// Nothing here ever touches a real socket — nodemailer, the settings
// manager and the credential store are all mocked. `createTransport`'s
// return value is controlled per test via its own mock.
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

jest.mock('../settings/settings-manager', () => ({
  getSettingsManager: jest.fn(),
}));

jest.mock('./mail-credential', () => ({
  getMailCredentialStore: jest.fn(),
}));

const DEFAULT_SETTINGS: MailSettings = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'smtpuser',
  from: 'noreply@example.com',
};

function mockSettings(overrides: Partial<MailSettings> = {}): void {
  (getSettingsManager as jest.Mock).mockReturnValue({
    getMailSettings: () => ({ ...DEFAULT_SETTINGS, ...overrides }),
  });
}

function mockCredential(password: string | null = 'test-password'): void {
  (getMailCredentialStore as jest.Mock).mockReturnValue({
    resolveMailPassword: jest.fn().mockResolvedValue(password),
  });
}

function mockTransport(sendMailImpl: () => Promise<unknown>): { sendMail: jest.Mock; close: jest.Mock } {
  const sendMail = jest.fn(sendMailImpl);
  const close = jest.fn();
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail, close });
  return { sendMail, close };
}

describe('sendTemplatedMail', () => {
  const originalAllowInsecure = process.env.DROP_SMTP_ALLOW_INSECURE_TLS;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DROP_SMTP_ALLOW_INSECURE_TLS;
    mockSettings();
    mockCredential();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalAllowInsecure === undefined) {
      delete process.env.DROP_SMTP_ALLOW_INSECURE_TLS;
    } else {
      process.env.DROP_SMTP_ALLOW_INSECURE_TLS = originalAllowInsecure;
    }
  });

  describe('missing configuration -> unavailable, never touches the relay', () => {
    it('returns unavailable when the host is missing', async () => {
      mockSettings({ host: undefined });

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when the from address is missing', async () => {
      mockSettings({ from: undefined });

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when no credential is available', async () => {
      mockCredential(null);

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('header injection refusal', () => {
    it('returns unavailable and never calls the relay when "to" contains CRLF', async () => {
      const result = await sendTemplatedMail(
        'test',
        'user@example.com\r\nBcc: victim@example.com',
        { platformUrl: 'https://drop.example.com' }
      );

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when "to" contains a NUL byte', async () => {
      const result = await sendTemplatedMail('test', 'user@exa\0mple.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when "to" is a comma-separated address list (one recipient per send only)', async () => {
      const result = await sendTemplatedMail('test', 'user@example.com,victim@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when "to" is a semicolon-separated address list', async () => {
      const result = await sendTemplatedMail('test', 'user@example.com;victim@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when "to" is empty', async () => {
      const result = await sendTemplatedMail('test', '', { platformUrl: 'https://drop.example.com' });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when the configured from address contains CRLF', async () => {
      mockSettings({ from: 'noreply@example.com\r\nBcc: victim@example.com' });

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('returns unavailable when a template variable that reaches the subject contains CRLF', async () => {
      const result = await sendTemplatedMail('share-notification', 'user@example.com', {
        appName: 'app\r\nBcc: victim@example.com',
        sharerName: 'alice',
        appUrl: 'https://my-app.example.com',
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('transport configuration', () => {
    it('builds a one-shot (no pool option) transport with TLS forced on by default', async () => {
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          requireTLS: true,
          tls: { rejectUnauthorized: true },
          auth: { user: 'smtpuser', pass: 'test-password' },
        })
      );
      const calledWith = (nodemailer.createTransport as jest.Mock).mock.calls[0][0];
      expect(calledWith.pool).toBeUndefined();
    });

    it('falls back to the from address as the auth username when smtpUser is unset', async () => {
      mockSettings({ user: undefined });
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ auth: { user: 'noreply@example.com', pass: 'test-password' } })
      );
    });

    it('relaxes TLS enforcement only when DROP_SMTP_ALLOW_INSECURE_TLS=true', async () => {
      process.env.DROP_SMTP_ALLOW_INSECURE_TLS = 'true';
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ requireTLS: false, tls: { rejectUnauthorized: false } })
      );
    });

    it('does not relax TLS enforcement for any other value of the opt-out env', async () => {
      process.env.DROP_SMTP_ALLOW_INSECURE_TLS = 'yes-please';
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ requireTLS: true, tls: { rejectUnauthorized: true } })
      );
    });
  });

  describe('status is relay-independent', () => {
    it('returns sent when the relay accepts the message', async () => {
      const { close } = mockTransport(async () => ({ messageId: '1' }));

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'sent' });
      expect(close).toHaveBeenCalled();
    });

    it('still returns sent when the relay rejects the send — status is never derived from the SMTP reply', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { close } = mockTransport(async () => {
        throw new Error('550 no such user');
      });

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'sent' });
      expect(close).toHaveBeenCalled();
      // The relay diagnostic went to the log, not the return value.
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('returns sent (bounded by the deadline, not hanging forever) when the relay never responds', async () => {
      jest.useFakeTimers();
      const neverResolves = () => new Promise<unknown>(() => {});
      mockTransport(neverResolves);

      const resultPromise = sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      await jest.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
      const result = await resultPromise;

      expect(result).toEqual({ status: 'sent' });
    });

    it('does not wait past the deadline even if the relay eventually would have responded', async () => {
      jest.useFakeTimers();
      const slowButFinite = () =>
        new Promise((resolve) => setTimeout(() => resolve({ messageId: '1' }), SEND_DEADLINE_MS * 10));
      mockTransport(slowButFinite);

      const start = Date.now();
      const resultPromise = sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      await jest.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
      const result = await resultPromise;

      // Fake timers make wall-clock elapsed time meaningless here; the
      // assertion that matters is that the promise settled after advancing
      // exactly the deadline, not the full 10x relay delay.
      expect(result).toEqual({ status: 'sent' });
      expect(Date.now() - start).toBeLessThan(SEND_DEADLINE_MS * 10);
    });
  });
});
