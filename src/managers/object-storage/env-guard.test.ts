/** Names an app may already set for itself (#301). */
import { APP_OWNED_AWS_NAMES } from './env-guard';

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
