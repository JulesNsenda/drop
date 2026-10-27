/**
 * Environment variable prefixes that carry the PLATFORM's secrets and
 * configuration — DROP's own, the operator's AWS credentials, and Cloudflare
 * tokens used for DNS challenges. A tenant's code must never inherit them.
 *
 * One list for every place that hands the platform's environment to something
 * running tenant code: the build sanitiser (`sanitizeBuildEnv`) and the PM2
 * start path (`Pm2Runtime`, via PM2's `filter_env`). Two lists would drift, and
 * one of the two would then leak the other's blind spot.
 */
export const RESERVED_ENV_PREFIXES = ['DROP_', 'AWS_', 'CF_'] as const;

/** Whether a variable name starts with a reserved platform prefix. */
export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}
