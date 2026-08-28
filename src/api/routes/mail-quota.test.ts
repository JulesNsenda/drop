/**
 * `sendMeteredMail` — the check -> send -> charge sequence, in one place.
 *
 * This suite exists because THE ORDERING IS THE CONTROL, and two hand-written
 * copies of this sequence had already diverged on it once (DROP-154 Gate 5):
 * `POST /admin/mail/test` charged the allowance BEFORE the send, so an
 * unconfigured relay burned quota for a message that never left — and the
 * first real sends after an operator finally configured mail were refused.
 *
 * So what is pinned here is not "mail gets sent". It is:
 *  - a quota refusal costs no relay conversation at all, and
 *  - the allowance is charged if and only if the relay was actually dialed.
 */

import { sendMeteredMail } from './mail-quota';
import { sendTemplatedMail } from '../../managers/mailer/mailer';
import { getMailQuota, resetMailQuota } from '../../managers/guardrail/principal-quota';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

jest.mock('../../managers/mailer/mailer', () => ({
  sendTemplatedMail: jest.fn(),
}));

const mockSend = sendTemplatedMail as jest.MockedFunction<typeof sendTemplatedMail>;

const TEST_VARS = { platformUrl: 'https://drop.example.com' } as const;
const ACTOR = { principalId: 'jwt::user-1', actorUserId: 'user-1' };

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-metered-mail-'));
  storePath = path.join(tmpDir, 'mail-quotas.json');
  resetMailQuota();
  getMailQuota(storePath);
  mockSend.mockReset();
});

afterEach(async () => {
  resetMailQuota();
  delete process.env.DROP_MAX_MAILS_PER_HOUR;
  delete process.env.DROP_MAX_MAILS_PER_HOUR_PER_USER;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('sendMeteredMail', () => {
  it('sends and charges the allowance when the relay was dialed', async () => {
    mockSend.mockResolvedValue({ status: 'attempted' });

    const result = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);

    expect(result).toEqual({ status: 'attempted' });
    expect(mockSend).toHaveBeenCalledWith('test', 'ops@example.com', TEST_VARS);
  });

  it('charges the allowance even when the relay conversation FAILED', async () => {
    // A relay that answered `550` or refused the connection still cost a real
    // outbound attempt. Not charging it would make a broken relay an unlimited
    // send loop, which is exactly the volume the quota exists to bound.
    process.env.DROP_MAX_MAILS_PER_HOUR = '1';
    resetMailQuota();
    getMailQuota(storePath);
    mockSend.mockResolvedValue({ status: 'attempted', failure: { reason: '550 user unknown' } });

    const first = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);
    expect(first.status).toBe('attempted');

    const second = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);
    expect(second.status).toBe('refused');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('does NOT charge the allowance when the relay was never dialed', async () => {
    // `unavailable` = no host/from/credential configured, or an input the
    // mailer itself refused. Nothing opened a socket. Charging these would
    // refuse the first REAL sends the moment an operator configures mail —
    // the DROP-154 Gate 5 bug, pinned so it cannot come back.
    process.env.DROP_MAX_MAILS_PER_HOUR = '1';
    resetMailQuota();
    getMailQuota(storePath);
    mockSend.mockResolvedValue({ status: 'unavailable' });

    const first = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);
    expect(first.status).toBe('unavailable');

    // The allowance is untouched, so a send that DOES reach the relay still works.
    mockSend.mockResolvedValue({ status: 'attempted' });
    const second = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);
    expect(second.status).toBe('attempted');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('refuses BEFORE dialing once the allowance is spent', async () => {
    // The refusal must cost no relay conversation — both because a refused
    // caller should not be able to make DROP talk to the relay, and because a
    // refusal that took the relay's round-trip time would leak, by latency
    // alone, facts a caller is not being told in the body.
    process.env.DROP_MAX_MAILS_PER_HOUR = '1';
    resetMailQuota();
    getMailQuota(storePath);
    mockSend.mockResolvedValue({ status: 'attempted' });

    await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);
    mockSend.mockClear();

    const result = await sendMeteredMail(ACTOR, 'test', 'ops@example.com', TEST_VARS);

    expect(result.status).toBe('refused');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses an actor with NO principal rather than sending unmetered', async () => {
    // Mail's instance is built with `unmeteredWithoutPrincipal: false`, unlike
    // the deploy one. An unmetered outbound channel is not the same thing as
    // automation with nothing to attribute volume to.
    mockSend.mockResolvedValue({ status: 'attempted' });

    const result = await sendMeteredMail({}, 'test', 'ops@example.com', TEST_VARS);

    expect(result).toEqual({ status: 'refused', reason: 'no_principal', retryAfterSeconds: undefined });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
