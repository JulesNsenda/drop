import nodemailer from 'nodemailer';
import { getSettingsManager } from '../settings/settings-manager';
import { getMailCredentialStore } from './mail-credential';
import { hostnameResolvesToBlockedIp } from '../../utils/ssrf-guard';
import { sendTemplatedMail, SEND_DEADLINE_MS, resetRelayHostCache } from './mailer';
import type { MailSettings } from '../settings/settings-manager';

// Nothing here ever touches a real socket or does a real DNS lookup —
// nodemailer, the settings manager, the credential store, and the SSRF host
// check are all mocked. `createTransport`'s return value is controlled per
// test via its own mock.
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

jest.mock('../../utils/ssrf-guard', () => ({
  hostnameResolvesToBlockedIp: jest.fn(),
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
  const originalAllowPrivateRelay = process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY;

  beforeEach(() => {
    jest.clearAllMocks();
    // The relay-host SSRF verdict is now cached per host (DROP-154 Gate 5
    // §4) — without this reset, an earlier test's cached verdict for the
    // same host would leak into a later test that reconfigures the mock for
    // that host, and the SSRF check below it would never actually run.
    resetRelayHostCache();
    delete process.env.DROP_SMTP_ALLOW_INSECURE_TLS;
    delete process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY;
    mockSettings();
    mockCredential();
    // Default: the configured relay host is NOT a blocked address — most
    // tests exercise send behaviour, not the SSRF check itself.
    (hostnameResolvesToBlockedIp as jest.Mock).mockResolvedValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalAllowInsecure === undefined) {
      delete process.env.DROP_SMTP_ALLOW_INSECURE_TLS;
    } else {
      process.env.DROP_SMTP_ALLOW_INSECURE_TLS = originalAllowInsecure;
    }
    if (originalAllowPrivateRelay === undefined) {
      delete process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY;
    } else {
      process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY = originalAllowPrivateRelay;
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

    it('resolves the credential against the configured host', async () => {
      const store = { resolveMailPassword: jest.fn().mockResolvedValue('test-password') };
      (getMailCredentialStore as jest.Mock).mockReturnValue(store);
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(store.resolveMailPassword).toHaveBeenCalledWith('smtp.example.com');
    });
  });

  describe('relay host validation (SSRF)', () => {
    it('returns unavailable and never dials when the configured host resolves to a blocked address', async () => {
      (hostnameResolvesToBlockedIp as jest.Mock).mockResolvedValue(true);

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'unavailable' });
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      // The credential is never even resolved for a refused host.
      expect(getMailCredentialStore).not.toHaveBeenCalled();
    });

    it('checks the host that is actually configured', async () => {
      mockSettings({ host: 'internal.corp' });
      (hostnameResolvesToBlockedIp as jest.Mock).mockResolvedValue(true);

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(hostnameResolvesToBlockedIp).toHaveBeenCalledWith('internal.corp');
    });

    it('resolves a given host only once — the verdict is cached across sends', async () => {
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });
      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(hostnameResolvesToBlockedIp).toHaveBeenCalledTimes(1);
    });

    it('dials a blocked host anyway when DROP_SMTP_ALLOW_PRIVATE_RELAY=true', async () => {
      process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY = 'true';
      (hostnameResolvesToBlockedIp as jest.Mock).mockResolvedValue(true);
      mockTransport(async () => ({ messageId: '1' }));

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'attempted' });
      expect(nodemailer.createTransport).toHaveBeenCalled();
      // The opt-out short-circuits the check entirely — it never even asks.
      expect(hostnameResolvesToBlockedIp).not.toHaveBeenCalled();
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

    it('relaxes certificate verification only — never requireTLS — when DROP_SMTP_ALLOW_INSECURE_TLS=true', async () => {
      process.env.DROP_SMTP_ALLOW_INSECURE_TLS = 'true';
      mockTransport(async () => ({ messageId: '1' }));

      await sendTemplatedMail('test', 'user@example.com', { platformUrl: 'https://drop.example.com' });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({ requireTLS: true, tls: { rejectUnauthorized: false } })
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

  describe('status is relay-independent, but `failure` carries what actually happened', () => {
    it('returns attempted with no failure when the relay accepts the message', async () => {
      const { close } = mockTransport(async () => ({ messageId: '1' }));

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result).toEqual({ status: 'attempted' });
      expect(close).toHaveBeenCalled();
    });

    it('still returns attempted (not unavailable) when the relay rejects the send — status is never derived from the SMTP reply', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { close } = mockTransport(async () => {
        throw new Error('550 no such user');
      });

      const result = await sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      expect(result.status).toBe('attempted');
      expect(close).toHaveBeenCalled();
      // The relay diagnostic went to the log AND to `failure` — never
      // anywhere else. It's the caller's job to decide who gets to read
      // `failure` (see mailer.types.ts's `MailFailureDetail`).
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(result).toEqual({ status: 'attempted', failure: { reason: '550 no such user' } });
      consoleErrorSpy.mockRestore();
    });

    it('returns attempted with a timeout failure (bounded by the deadline, not hanging forever) when the relay never responds', async () => {
      jest.useFakeTimers();
      const neverResolves = () => new Promise<unknown>(() => {});
      mockTransport(neverResolves);

      const resultPromise = sendTemplatedMail('test', 'user@example.com', {
        platformUrl: 'https://drop.example.com',
      });

      await jest.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
      const result = await resultPromise;

      // The relay never even replied before the deadline gave up — this is
      // one of the four failure modes `MailFailureDetail` exists to surface
      // (plan §1), not silence: it reports a generic reason since no actual
      // relay error arrived.
      expect(result).toEqual({
        status: 'attempted',
        failure: { reason: `no relay response within ${SEND_DEADLINE_MS}ms` },
      });
    });

    it('does not wait past the deadline even if the relay eventually would have responded, and reports the timeout as a failure', async () => {
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
      // exactly the deadline, not the full 10x relay delay — and that the
      // still-pending attempt is reported as a failure, not a bare success.
      expect(result).toEqual({
        status: 'attempted',
        failure: { reason: `no relay response within ${SEND_DEADLINE_MS}ms` },
      });
      expect(Date.now() - start).toBeLessThan(SEND_DEADLINE_MS * 10);
    });
  });
});
