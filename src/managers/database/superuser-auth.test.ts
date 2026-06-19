import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  resolveSuperuserPassword,
  hbaNeedsMigration,
  toScramHbaConf,
  superuserPasswordPath,
} from './superuser-auth';

const TRUST_HBA = `
# DROP Platform - Local connections only
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
`;

describe('superuser-auth', () => {
  describe('hbaNeedsMigration', () => {
    it('detects trust host lines', () => {
      expect(hbaNeedsMigration(TRUST_HBA)).toBe(true);
    });

    it('returns false once host lines are scram', () => {
      expect(hbaNeedsMigration(toScramHbaConf(TRUST_HBA))).toBe(false);
    });
  });

  describe('toScramHbaConf', () => {
    it('replaces trust with scram-sha-256 on host and local lines', () => {
      const out = toScramHbaConf(TRUST_HBA);
      expect(out).toContain('host    all             all             127.0.0.1/32            scram-sha-256');
      expect(out).toContain('host    all             all             ::1/128                 scram-sha-256');
      // local (unix-socket) lines are also migrated — containers reach Postgres
      // via socket and must not get trust access.
      expect(out).toContain('local   all             all                                     scram-sha-256');
      expect(out).not.toMatch(/\btrust\b/);
    });

    it('is idempotent', () => {
      const once = toScramHbaConf(TRUST_HBA);
      expect(toScramHbaConf(once)).toBe(once);
    });
  });

  describe('resolveSuperuserPassword', () => {
    let dropRoot: string;

    beforeEach(async () => {
      dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-pgsu-'));
    });

    afterEach(async () => {
      await fs.rm(dropRoot, { recursive: true, force: true });
    });

    it('generates and persists a password on first call', async () => {
      const pw = await resolveSuperuserPassword(dropRoot);
      expect(pw).toMatch(/^[0-9a-f]{48}$/);
      const onDisk = (await fs.readFile(superuserPasswordPath(dropRoot), 'utf-8')).trim();
      expect(onDisk).toBe(pw);
    });

    it('returns the same password on subsequent calls', async () => {
      const first = await resolveSuperuserPassword(dropRoot);
      const second = await resolveSuperuserPassword(dropRoot);
      expect(second).toBe(first);
    });
  });
});
