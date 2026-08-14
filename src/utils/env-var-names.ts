/**
 * Environment variable NAME policy — shape only, deliberately not a denylist.
 *
 * There used to be a `RESERVED_ENV_VARS` list here (DROP-150 / B1), naming the
 * variables DROP injects so a tenant-authored `depends_on[].env` could be
 * refused before it overwrote one. That approach was structurally incomplete
 * and has been removed: the start env also carries the app's own secrets, and
 * `depends_on` was spread after those too, so the set a manifest must not be
 * able to claim includes every secret name the owner has ever set — unbounded,
 * and impossible to enumerate. Two provisioner variables (`REDIS_DB`, and the
 * whole `DB_*` family) had already slipped past the list, which is the smaller
 * version of the same lesson.
 *
 * The collision check is therefore POSITIONAL and lives in `buildStartSpec`
 * (platform.ts): a `depends_on` entry may fill a gap in the assembled env,
 * never overwrite an entry already in it. That is complete by construction and
 * needs no list to maintain. Do not reintroduce one here.
 *
 * What remains is the shape check below, which is a different job: stopping a
 * name from carrying characters that break the env encoding downstream. A
 * container's environment is assembled as `${k}=${v}` (container-manager.ts),
 * so a name containing `=` or a newline would forge an additional variable
 * rather than merely being odd.
 */

/**
 * Mirrors the parser's `SECRET_NAME_REGEX`, duplicated rather than exported
 * from `drop-yaml-parser.ts` so this module stays free of detector imports.
 */
const ENV_VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * True if `name` is usable as an environment variable name.
 *
 * Applied in `resolveDependencies`, NOT in the drop.yaml validator: a
 * parse-time rejection discards the entire manifest (`warnParseFailure`), which
 * would break already-deployed `depends_on` entries and — worse — fail open,
 * since a discarded config leaves `secrets:` undeclared and the required-secret
 * preflight then finds nothing missing.
 */
export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME_REGEX.test(name);
}
