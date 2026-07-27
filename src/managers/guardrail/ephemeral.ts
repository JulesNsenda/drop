/**
 * Ephemeral deploys (Step 10).
 *
 * An agent testing a change wants a throwaway app that cleans itself up. The
 * risk is everything an agent can do with "throwaway": invent unbounded names,
 * consume every slot on the box, and route unreviewed code onto a hostname that
 * looks like production.
 */

import * as crypto from 'crypto';
import { isValidAppName } from '../../api/middleware/validate';

/** Default lifetime when a caller does not say. */
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_MAX_TTL_MINUTES = 1440;
/**
 * Live ephemerals per caller.
 *
 * Per PRINCIPAL and per owning USER, never global. A single global cap is a
 * denial-of-service handed to any tenant: three ephemerals and nobody else on
 * the box can make one (SEC-7).
 */
const DEFAULT_MAX_PER_PRINCIPAL = 3;

/** APP_NAME_RE allows 64 chars total. */
const MAX_APP_NAME = 64;
/** Random suffix, hex. Long enough that a collision is not the failure mode. */
const SUFFIX_HEX_CHARS = 10;

export function maxTtlMinutes(): number {
  const raw = parseInt(process.env.DROP_MAX_EPHEMERAL_TTL_MIN || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_TTL_MINUTES;
}

export function maxEphemeralsPerPrincipal(): number {
  const raw = parseInt(process.env.DROP_MAX_EPHEMERAL_PER_PRINCIPAL || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_PRINCIPAL;
}

/**
 * Clamp a requested TTL into range.
 *
 * A missing or nonsense value takes the default rather than the maximum: an
 * unparseable number must not buy the longest possible lifetime.
 */
export function resolveTtlMinutes(requested?: number): number {
  const max = maxTtlMinutes();
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return Math.min(DEFAULT_TTL_MINUTES, max);
  }
  return Math.min(Math.floor(requested), max);
}

/**
 * A collision-resistant ephemeral app name derived from a caller's suggestion.
 *
 * The caller portion is truncated so that base + separator + suffix can never
 * exceed APP_NAME_RE's 64 characters — v1's "64 chars plus a short suffix"
 * could overflow the limit outright, and truncating AFTER appending could drop
 * the random part and reintroduce collisions (SEC-16).
 *
 * Returns null when the result is not a valid app name, so the caller refuses
 * rather than deploying under a name the rest of the platform will reject.
 */
export function ephemeralAppName(
  suggested: string | undefined,
  randomHex: () => string = () => crypto.randomBytes(8).toString('hex')
): string | null {
  const suffix = randomHex().replace(/[^a-f0-9]/gi, '').slice(0, SUFFIX_HEX_CHARS);
  if (suffix.length < SUFFIX_HEX_CHARS) return null;

  // Reserve room for the separator and the suffix BEFORE truncating.
  const budget = MAX_APP_NAME - SUFFIX_HEX_CHARS - 1;
  const cleaned = (suggested ?? 'tmp')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, budget);
  // Everything the caller supplied may have been stripped.
  const base = cleaned.length > 0 ? cleaned : 'tmp';

  const name = `${base}-${suffix}`;
  return isValidAppName(name) ? name : null;
}

export interface EphemeralRecord {
  name: string;
  principalId?: string;
  userId?: string;
  expiresAt: string;
}

/** Whether an ephemeral's lifetime has run out. */
export function isExpired(record: { expiresAt?: string }, now: number): boolean {
  if (!record.expiresAt) return false;
  const at = new Date(record.expiresAt).getTime();
  // A MALFORMED timestamp counts as expired, not immortal: every comparison
  // against NaN is false, so a naive `at <= now` would keep a corrupt record
  // alive forever — the same trap deploy-detail's retention hit.
  if (!Number.isFinite(at)) return true;
  return at <= now;
}

/** Refusal raised when a caller already has its allowance of live ephemerals. */
export class EphemeralQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EphemeralQuotaError';
  }
}

export interface QuotaCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Whether this caller may create another ephemeral.
 *
 * Counted per principal AND per owning user, so an agent cannot escape its
 * allowance by re-minting a session, and a human cannot exceed theirs by
 * spreading work across several agents.
 */
export function checkEphemeralQuota(
  existing: EphemeralRecord[],
  actor: { principalId?: string; userId?: string },
  now: number
): QuotaCheck {
  const live = existing.filter((e) => !isExpired(e, now));
  const limit = maxEphemeralsPerPrincipal();

  if (actor.principalId) {
    const mine = live.filter((e) => e.principalId === actor.principalId).length;
    if (mine >= limit) {
      return {
        allowed: false,
        reason: `This credential already has ${mine} live ephemeral app(s); the limit is ${limit}.`,
      };
    }
  }
  if (actor.userId) {
    const ours = live.filter((e) => e.userId === actor.userId).length;
    if (ours >= limit) {
      return {
        allowed: false,
        reason: `You already have ${ours} live ephemeral app(s); the limit is ${limit}.`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Whether an ephemeral may be promoted automatically.
 *
 * `DROP_EPHEMERAL_AUTO_PROMOTE` must be set explicitly to allow it, and it is
 * IGNORED when the platform default is manual. v1 forced `auto` for ephemerals,
 * which let an agent bypass an operator's `DROP_DEFAULT_PROMOTION=manual`
 * simply by passing `ephemeral: true` — the gate would have been optional to
 * exactly the caller it was written for.
 */
export function ephemeralAutoPromoteAllowed(platformDefault: 'auto' | 'manual'): boolean {
  if (platformDefault === 'manual') return false;
  return process.env.DROP_EPHEMERAL_AUTO_PROMOTE === 'true';
}

export { DEFAULT_TTL_MINUTES, MAX_APP_NAME, SUFFIX_HEX_CHARS };
