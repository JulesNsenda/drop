/**
 * Promotion gate (Step 6d).
 *
 * When an app is set to `manual` promotion, a build is allowed to run but the
 * result is NOT put in front of traffic until a human promotes it.
 *
 * WHY BUILD-AND-HOLD RATHER THAN THE PLAN'S PORT SWAP
 * ---------------------------------------------------
 * The plan specifies: the unapproved deploy starts on a NEW port while the
 * route keeps pointing at the previously-approved port, and `promote` flips the
 * upstream. That shape requires the OLD process to still be running, i.e. two
 * live processes for one app — and DROP cannot do that today. Both runtimes
 * derive process identity purely from the app name: `containerName(spec.name)`
 * in container-manager, `name: spec.name` in pm2-runtime. Worse, the container
 * path calls `removeIfExists(name)` on start, so bringing the new version up
 * DESTROYS the approved one. Making it work needs a second app identity for the
 * pending version — its own config, state entry, ports, logs and teardown path
 * — which is a far larger change than the gate itself.
 *
 * So the hold happens one step earlier: the build runs (an agent still gets its
 * build feedback), and the running version is left completely untouched until a
 * human promotes. That preserves the invariant the gate exists for —
 * unapproved code never serves — on BOTH the first deploy and every redeploy,
 * which is precisely what SEC-9 found broken in the withhold-the-route design
 * (that only ever gated the first deploy; on a redeploy the route already
 * existed and unapproved code was live the instant it started).
 *
 * What it costs: an operator cannot exercise the new version on a side port
 * before promoting. That is a real loss, and the honest trade for not running
 * two identities.
 */

export type PromotionMode = 'auto' | 'manual';

/** Platform-wide default, overridable per app. */
export function defaultPromotionMode(): PromotionMode {
  return process.env.DROP_DEFAULT_PROMOTION === 'manual' ? 'manual' : 'auto';
}

/**
 * The mode in force for an app.
 *
 * A per-app value always wins, including when it says `auto` on a platform
 * defaulting to `manual` — an operator who marked one app auto meant it.
 */
export function promotionModeFor(configured: PromotionMode | undefined): PromotionMode {
  if (configured === 'manual' || configured === 'auto') return configured;
  return defaultPromotionMode();
}

export interface PendingPromotion {
  /** The deploy whose output is held. Correlates with the deploy episode. */
  deployId?: string;
  builtAt: string;
  /** Build output dir, so promoting starts exactly what was built. */
  outputDirectory?: string;
}

/**
 * Whether this build must be held.
 *
 * Deliberately NOT a function of who deployed. The gate is an operator's
 * standing decision about an app, not a judgement about the caller — making it
 * caller-dependent would mean a human's own deploy silently skipped the gate
 * they set, and an agent could look for a path that presents as human.
 */
export function shouldHoldForPromotion(mode: PromotionMode): boolean {
  return mode === 'manual';
}
