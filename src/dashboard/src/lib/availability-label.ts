/**
 * Maps an extension descriptor's `availability` to what the catalog card
 * actually renders (DROP-151 Phase 1). This is the risky half of the catalog
 * feature, not `catalog-filter.ts` — a wrong string here is a card that lies
 * to the reader about why something can't be added, so it carries the careful
 * tests (UX finding U11, *medium/high* in the plan).
 *
 * Deliberately free of React, same reasons as `catalog-filter.ts` and
 * `db-format.ts`: no test runner in `src/dashboard/package.json`, so this
 * rides the root jest project instead.
 *
 * Three rules the copy below exists to satisfy — do not loosen them without
 * re-reading the plan (`docs/plans/2026-08-16-extension-catalog.md`, Phase 1):
 *
 * 1. `redis-not-ready` must not claim a single cause. `ApiServerConfig`
 *    exposes neither `isolation` nor `enableRedis`, and the platform nulls
 *    the Redis server and provisioner together on a soft failure — so the
 *    route genuinely cannot tell "managed Redis is disabled in this
 *    platform's configuration" apart from "it failed to start". Saying either
 *    one alone would be a guess dressed up as a fact.
 * 2. Nothing here may read as if the reader did something wrong. These are
 *    platform-scope states (see the plan's Phase 1 file-level note on
 *    `availability`), not the reader's fault, so the copy points at an
 *    operator action instead of asking the reader to fix anything.
 * 3. Never emit a host path, a binary path, or a raw error string. The
 *    `ExtensionUnavailableReason` union is closed precisely so this module
 *    can never be handed one — keep it that way rather than adding a
 *    fallback branch that echoes an arbitrary reason/message through.
 */

import type { ExtensionUnavailableReason } from './catalog-filter';

/** Matches `components/ui/Badge.tsx`'s `BadgeTone` values it feeds — the
 * catalog card can pass this straight into `<Badge tone>` without a cast. */
export type AvailabilityTone = 'ok' | 'neutral';

export interface AvailabilityInput {
  availability: 'available' | 'unavailable';
  unavailableReason?: ExtensionUnavailableReason;
}

export interface AvailabilityLabel {
  tone: AvailabilityTone;
  /** Short badge text. */
  label: string;
  /** Longer, one/two-sentence explanation shown alongside the badge. */
  detail: string;
  /** Whether the card's Add affordance (the `drop.yaml` snippet) should render. */
  canAdd: boolean;
}

const UNAVAILABLE_COPY: Record<ExtensionUnavailableReason, Pick<AvailabilityLabel, 'detail'>> = {
  'postgres-not-ready': {
    detail:
      "This platform's bundled PostgreSQL hasn't finished starting yet, so this can't be added right now. Ask an operator to check the database's status.",
  },
  'redis-not-ready': {
    detail:
      "Managed Redis isn't available on this platform right now — it may be turned off in this platform's configuration, or it may have failed to start; this card can't tell which. Ask an operator to check the platform's Redis setting and its logs.",
  },
};

/** Fallback for an `unavailable` descriptor whose reason this build cannot
 * render: either absent, or a value added to the server's union after this
 * bundle was built. The second case is real — the dashboard is a separate
 * package and a browser can hold a cached bundle older than the API serving
 * it — so the lookup below must be indexed defensively rather than trusting
 * the wire value to be a key. Stays generic and still points at an operator
 * rather than guessing at a cause. */
const UNKNOWN_UNAVAILABLE_DETAIL =
  "This isn't available on this platform right now. Ask an operator to check.";

/**
 * Pure `availability` → card copy mapping. No JSX, no fetch, no side effects
 * — a plain data return so it stays testable without a DOM.
 */
export function describeAvailability(input: AvailabilityInput): AvailabilityLabel {
  if (input.availability === 'available') {
    return {
      tone: 'ok',
      label: 'Available',
      detail: 'Ready to add to an app.',
      canAdd: true,
    };
  }

  const detail = input.unavailableReason
    ? (UNAVAILABLE_COPY[input.unavailableReason]?.detail ?? UNKNOWN_UNAVAILABLE_DETAIL)
    : UNKNOWN_UNAVAILABLE_DETAIL;

  return {
    tone: 'neutral',
    label: 'Not available',
    detail,
    canAdd: false,
  };
}
