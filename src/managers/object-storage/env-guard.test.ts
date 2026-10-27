/** Environment hygiene for object storage (#301). */
import { APP_OWNED_AWS_NAMES, blankInheritedAdminEnv } from './env-guard';

describe('blankInheritedAdminEnv', () => {
  it('blanks inherited DROP_S3_* and AWS_* the app was not given', () => {
    const out = blankInheritedAdminEnv(
      {
        PATH: '/usr/bin',
        DROP_S3_ADMIN_ACCESS_KEY_ID: 'AKIAADMIN',
        DROP_S3_ADMIN_SECRET_ACCESS_KEY: 'secret',
        AWS_ACCESS_KEY_ID: 'AKIAHOST',
        AWS_SESSION_TOKEN: 'token',
        AWS_PROFILE: 'p',
      },
      { PORT: '3000' }
    );

    expect(out).toEqual({
      PORT: '3000',
      DROP_S3_ADMIN_ACCESS_KEY_ID: '',
      DROP_S3_ADMIN_SECRET_ACCESS_KEY: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: '',
    });
  });

  it('never overrides a value the app was deliberately given, and leaves other variables alone', () => {
    const out = blankInheritedAdminEnv(
      { AWS_ACCESS_KEY_ID: 'AKIAHOST', AWS_REGION: 'us-east-1', NODE_ENV: 'production' },
      { AWS_ACCESS_KEY_ID: 'AKIAINJECTED', AWS_REGION: 'eu-central-1' }
    );

    expect(out).toEqual({ AWS_ACCESS_KEY_ID: 'AKIAINJECTED', AWS_REGION: 'eu-central-1' });
  });

  it('does not mutate its input', () => {
    const env = { PORT: '1' };
    blankInheritedAdminEnv({ AWS_PROFILE: 'p' }, env);
    expect(env).toEqual({ PORT: '1' });
  });
});

describe('APP_OWNED_AWS_NAMES', () => {
  it('covers every name an AWS SDK resolves credentials, region or endpoint from', () => {
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_S3',
      'S3_BUCKET',
    ]) {
      expect(APP_OWNED_AWS_NAMES).toContain(name);
    }
  });
});
