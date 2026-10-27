/**
 * The platform's secrets must not reach a PM2 app (isolation: none).
 *
 * PM2 starts an app with its own client's environment underneath the `env` it
 * is given, so DROP_*, AWS_* and CF_* from the platform process would be
 * inherited by tenant code. The runtime asks PM2 to filter them out
 * (`filter_env`); this test runs PM2's REAL option resolution on exactly the
 * options `ProcessManager` builds, rather than trusting that the flag does what
 * its name says.
 */
import * as path from 'path';
import { RESERVED_ENV_PREFIXES } from '../../utils/reserved-env';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Common = require('pm2/lib/Common');

describe('PM2 filter_env with the reserved platform prefixes', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function resolveEnv(explicit: Record<string, string>): Record<string, string> {
    const app = Common.prepareAppConf(
      { cwd: __dirname },
      {
        name: 'tenant',
        script: path.basename(__filename),
        cwd: __dirname,
        env: explicit,
        filter_env: [...RESERVED_ENV_PREFIXES],
      }
    );
    if (app instanceof Error) throw app;
    return app.env;
  }

  it('removes the platform secrets the app would inherit, whatever the prefix', () => {
    process.env.DROP_S3_ADMIN_ACCESS_KEY_ID = 'AKIAADMIN';
    process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY = 'admin-secret';
    process.env.AWS_ACCESS_KEY_ID = 'AKIAHOST';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_PROFILE = 'host-profile';
    process.env.CF_API_TOKEN = 'cloudflare-token';
    process.env.DROP_JWT_SECRET = 'jwt';

    const env = resolveEnv({});

    for (const name of [
      'DROP_S3_ADMIN_ACCESS_KEY_ID',
      'DROP_S3_ADMIN_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_REGION',
      'AWS_PROFILE',
      'CF_API_TOKEN',
      'DROP_JWT_SECRET',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('keeps what the app was explicitly given, even under a reserved prefix', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAHOST';
    process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY = 'admin-secret';

    const env = resolveEnv({
      DROP_DATA_DIR: '/data/app',
      AWS_ACCESS_KEY_ID: 'AKIAINJECTED',
      AWS_REGION: 'eu-central-1',
      S3_BUCKET: 'b',
    });

    expect(env.DROP_DATA_DIR).toBe('/data/app');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAINJECTED');
    expect(env.AWS_REGION).toBe('eu-central-1');
    expect(env.S3_BUCKET).toBe('b');
    expect(env).not.toHaveProperty('DROP_S3_ADMIN_SECRET_ACCESS_KEY');
  });

  it('leaves the ordinary environment (PATH and the like) alone', () => {
    process.env.SOME_ORDINARY_SETTING = 'kept';
    expect(resolveEnv({}).SOME_ORDINARY_SETTING).toBe('kept');
    expect(resolveEnv({}).PATH ?? resolveEnv({}).Path).toBeDefined();
  });
});
