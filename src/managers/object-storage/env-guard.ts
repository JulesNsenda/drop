/**
 * Names an app may already set for itself (#301).
 *
 * (Keeping the platform's own `DROP_S3_ADMIN_*` / `AWS_*` out of a PM2 app is
 * not done here: it is the general reserved-prefix filter in
 * `utils/reserved-env.ts`, applied at the PM2 runtime seam.)
 */

/**
 * The names DROP injects for an attached bucket, plus every other name an AWS
 * SDK resolves credentials, a region, or an endpoint from. An app that
 * already sets ANY of them is talking to some AWS endpoint of its own, and
 * attaching would silently repoint it.
 */
export const APP_OWNED_AWS_NAMES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'S3_BUCKET',
] as const;
