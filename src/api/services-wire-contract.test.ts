/**
 * Compile-time equivalence pin between the server's DROP-151 Phase 3 detach
 * wire types and the dashboard's copy (`attach-state.ts`, DatabaseTab.tsx's
 * DELETE /apps/:name/services/:id response shape).
 *
 * `DetachServiceSuccess` (a deliberately FLATTENED, all-optional-fields view
 * of the discriminated success union — see `attach-state.ts`'s header for
 * why) and the restart-outcome discriminant stay hand-mirrored rather than
 * imported: the dashboard is a separate npm package (see root CLAUDE.md),
 * and `platform-ops.ts` itself pulls in `../managers/runtime` (the PM2/
 * Docker adapters), so a type-only import of it would still force `cd
 * src/dashboard && npx tsc --noEmit` to resolve that whole graph under a
 * *different* tsconfig than this one. THIS file is the drift detector for
 * both: it lives in the server's own tree, compiles under the root
 * tsconfig/ts-jest, and asserts assignability directly rather than trusting
 * two comments to agree by inspection. `backup.file` drifted once (optional
 * on the server, required in the dashboard's copy) and the `restart` union
 * drifted once before that and was fixed by hand — this test exists so a
 * THIRD drift fails the suite instead of shipping.
 *
 * `DetachRefusalReason` is the one exception: `attach-state.ts` now derives
 * it directly from the server's own type (`services-wire.types.ts`, a
 * zero-import leaf module `platform-ops.ts` re-exports), so the third `it`
 * below is guaranteed to pass by construction — it stays as a readable
 * assertion of the invariant, not a live drift detector.
 */

import type { DetachServiceResult, DetachServiceRestartOutcome } from './platform-ops';
import type { DetachServiceSuccess, DetachRefusalReason } from '../dashboard/src/components/attach-state';

// The server's success union (both `deprovisioned: false` and `deprovisioned:
// true` arms) — what a real DELETE /apps/:name/services/:id 200 body is
// shaped like.
type ServerDetachSuccess = Extract<DetachServiceResult, { detached: true }>;

// The server's refusal `reason` across every refusal arm.
type ServerDetachRefusalReason = Extract<DetachServiceResult, { detached: false }>['reason'];

describe('DetachServiceResult (server) <-> DetachServiceSuccess/DetachRefusalReason (dashboard) wire pin', () => {
  it('every server success value is assignable to the dashboard success type (catches the backup.file-style drift)', () => {
    // A compile error here means the dashboard's `DetachServiceSuccess`
    // declares something the server does NOT guarantee — e.g. `file:
    // string` when the server only promises `file?: string`. That is
    // exactly the bug this test exists to catch: the dashboard rendered
    // `undefined` as though it were a real basename.
    const fromServer = (s: ServerDetachSuccess): DetachServiceSuccess => s;
    expect(typeof fromServer).toBe('function');
  });

  it("the two trees' restart-outcome discriminant is the exact same literal set", () => {
    // Deliberately bidirectional: unlike `backup.file`, the restart values
    // carry no extra required field on either side (the server's
    // `missingSecrets` on the `needs-config` arm is additional data the
    // dashboard doesn't need, not a narrowing), so a true set match is
    // meaningful here — the union already drifted once and was fixed by
    // hand.
    const toDashboard = (r: DetachServiceRestartOutcome['restart']): DetachServiceSuccess['restart'] => r;
    const toServer = (r: DetachServiceSuccess['restart']): DetachServiceRestartOutcome['restart'] => r;
    expect(typeof toDashboard).toBe('function');
    expect(typeof toServer).toBe('function');
  });

  it('the closed detach refusal-reason unions match exactly in both directions', () => {
    // DetachRefusalReason is now derived directly from the server's own
    // type (see this file's header) rather than hand-copied, so this holds
    // by construction — kept as a readable assertion of the invariant.
    const toDashboard = (r: ServerDetachRefusalReason): DetachRefusalReason => r;
    const toServer = (r: DetachRefusalReason): ServerDetachRefusalReason => r;
    expect(typeof toDashboard).toBe('function');
    expect(typeof toServer).toBe('function');
  });
});
