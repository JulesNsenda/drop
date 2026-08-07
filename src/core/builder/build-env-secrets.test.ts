/**
 * Platform secrets must never reach a tenant-authored build command.
 *
 * The bug this pins: `sanitizeBuildEnv` stripped `DROP_*`/`AWS_*`/`CF_*` out of
 * `process.env` and then spread the caller's overrides back on top UNFILTERED,
 * while `BuilderService.executeEnvironment` seeded `context.env` from
 * `process.env`. Net effect — from the install stage onward the filter was a
 * no-op, on both the host and container runners, and a one-line `postinstall`
 * in any tenant's package.json could read `DROP_MASTER_KEY` (the passphrase
 * for every app's encrypted secrets), the GitHub webhook secret, and the
 * CF/AWS tokens that control the platform's own DNS.
 *
 * Two independent defences are asserted here, because either alone would have
 * been enough to prevent the incident and neither alone is enough to keep it
 * prevented:
 *   1. the boundary filters overrides, not just the parent env
 *   2. the caller no longer launders the parent env through overrides
 */

import { sanitizeBuildEnv } from './strategies/base';

describe('sanitizeBuildEnv', () => {
  const SECRETS = {
    DROP_MASTER_KEY: 'master-passphrase',
    DROP_GITHUB_WEBHOOK_SECRET: 'hmac-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CF_API_TOKEN: 'cloudflare-token',
  };
  const saved: Record<string, string | undefined> = {};
  let warn: jest.SpyInstance;

  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    warn = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    for (const k of Object.keys(SECRETS)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    warn.mockRestore();
  });

  it('strips platform secrets from the parent env', () => {
    const env = sanitizeBuildEnv();
    for (const key of Object.keys(SECRETS)) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('does NOT let an override re-introduce a stripped secret', () => {
    // The exact laundering path: a caller passing process.env through as
    // overrides. Before the fix every one of these came back.
    const env = sanitizeBuildEnv({ ...process.env } as Record<string, string>);
    for (const key of Object.keys(SECRETS)) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('refuses a reserved-prefix override even when the value is attacker-chosen', () => {
    const env = sanitizeBuildEnv({ DROP_MASTER_KEY: 'attacker-supplied' });
    expect(env.DROP_MASTER_KEY).toBeUndefined();
  });

  it('warns rather than dropping a reserved override silently', () => {
    sanitizeBuildEnv({ DROP_SOMETHING: 'x' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DROP_SOMETHING'));
  });

  it('still passes ordinary overrides through', () => {
    const env = sanitizeBuildEnv({ NODE_ENV: 'production', VITE_API_BASE: '/api' });
    expect(env.NODE_ENV).toBe('production');
    expect(env.VITE_API_BASE).toBe('/api');
  });

  it('preserves the parent-env variables a build actually needs', () => {
    // PATH is the one that matters — without it npm/node are unrunnable. The
    // filter must be a prefix denylist, never an allowlist.
    process.env.SOME_NEUTRAL_VAR = 'kept';
    try {
      const env = sanitizeBuildEnv();
      expect(env.PATH ?? env.Path).toBeDefined();
      expect(env.SOME_NEUTRAL_VAR).toBe('kept');
    } finally {
      delete process.env.SOME_NEUTRAL_VAR;
    }
  });
});

describe('BuilderService does not launder the parent env into overrides', () => {
  it('executeEnvironment does not merge process.env into context.env', () => {
    // Asserted at the source because the merge is a private stage with no
    // observable output of its own, and because the property that matters is
    // the absence of a spread — which a behavioural test would have to
    // reconstruct the whole build pipeline to observe.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'builder.ts'),
      'utf-8'
    ) as string;
    const start = source.indexOf('private async executeEnvironment');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('private async executeInstall', start));
    expect(body).not.toContain('...process.env');
  });
});
