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

/**
 * `env` plus an explicit EMPTY value for every reserved-prefix variable in
 * `inherited` that `env` does not itself set.
 *
 * PM2's `filter_env` strips these on a fresh start, but PM2 restarts a stopped
 * entry through a different path (`_startJson` with `updateEnv`) that seeds the
 * app from the platform's own `process.env` and does not apply it. An explicit
 * empty value wins on EVERY path, and reads as unset to every SDK. Anything
 * the app was deliberately given is left alone.
 */
export function withReservedEnvBlanked(
  inherited: NodeJS.ProcessEnv,
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...env };
  for (const name of Object.keys(inherited)) {
    if (isReservedEnvName(name) && !Object.hasOwn(out, name)) out[name] = '';
  }
  return out;
}

/** Whether a variable name starts with a reserved platform prefix. */
export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}
