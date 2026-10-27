/**
 * Environment hygiene for object storage (#301).
 *
 * DROP holds ONE AWS admin credential for the operator's account. It reaches
 * the platform through `DROP_S3_ADMIN_*` (or the ambient `AWS_*` chain), i.e.
 * through the platform's own process environment — and a PM2 app inherits
 * that environment unless told otherwise. Under Docker an app gets only what
 * the spec lists; under PM2 (`isolation: none`) it gets everything.
 */

/** Prefixes of platform-process variables an app must never inherit. */
const ADMIN_ENV_PREFIXES = ['DROP_S3_', 'AWS_'];

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

/**
 * `env` plus an explicit empty value for every platform-process variable an
 * app must not inherit (and which `env` does not itself set). PM2 merges its
 * own environment under the app's, so the only way to take an inherited
 * variable away from the app is to override it. An empty value reads as unset
 * to every AWS SDK. Anything the app was deliberately given — its own
 * secrets, the injected bucket variables — is untouched.
 */
export function blankInheritedAdminEnv(
  inherited: NodeJS.ProcessEnv,
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const name of Object.keys(inherited)) {
    if (ADMIN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) && !Object.hasOwn(out, name)) {
      out[name] = '';
    }
  }
  return out;
}
