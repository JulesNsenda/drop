/**
 * `canOpen` — the browser access-gate authorization rule (DROP-152).
 *
 * The point of this suite is the posture DIFFERENCE from `canAccess`, which
 * lives beside it in the same file and returns `true` with no auth context.
 * Copying that posture here would make an auth-disabled box serve every gated
 * app to anonymous traffic while reporting it as gated — the third boundary
 * where inheriting it would have been wrong (`interactiveSessionOnly` was the
 * second).
 */

import { canOpen, canAccess } from './access';
import type { AuthContext } from './middleware/auth';
import type { AppAccessPolicy } from '../managers/app/app-config';

const ctx = (over: Partial<AuthContext>): AuthContext => ({
  userId: 'user-1',
  username: 'alice',
  role: 'user',
  authMethod: 'jwt',
  ...over,
});

const gated = (allow: string[]): AppAccessPolicy => ({ mode: 'drop-users', allow });

describe('canOpen', () => {
  it('is true for an UNGATED app — absent policy means not gated, unchanged behaviour', () => {
    expect(canOpen(ctx({ userId: 'nobody' }), { userId: 'owner-1' }, undefined)).toBe(true);
    expect(canOpen(undefined, { userId: 'owner-1' }, undefined)).toBe(true);
  });

  it('fails CLOSED with no auth context, where canAccess fails open', () => {
    const policy = gated(['user-1']);
    expect(canOpen(undefined, { userId: 'owner-1' }, policy)).toBe(false);
    // The divergence is the whole point — pinned so a future "simplification"
    // that delegates to canAccess fails here rather than in production.
    expect(canAccess(undefined, { userId: 'owner-1' })).toBe(true);
  });

  it('admits an admin', () => {
    expect(canOpen(ctx({ userId: 'admin-1', role: 'admin' }), { userId: 'owner-1' }, gated([]))).toBe(
      true
    );
  });

  it('admits the owner even when the allow-list omits them', () => {
    expect(canOpen(ctx({ userId: 'owner-1' }), { userId: 'owner-1' }, gated(['someone-else']))).toBe(
      true
    );
  });

  it('admits a user named in the allow-list', () => {
    expect(canOpen(ctx({ userId: 'user-1' }), { userId: 'owner-1' }, gated(['user-1']))).toBe(true);
  });

  it('refuses a valid principal who is neither owner, admin, nor listed', () => {
    expect(canOpen(ctx({ userId: 'user-9' }), { userId: 'owner-1' }, gated(['user-1']))).toBe(false);
  });

  it('refuses an empty allow-list for everyone but the owner and admins', () => {
    expect(canOpen(ctx({ userId: 'user-9' }), { userId: 'owner-1' }, gated([]))).toBe(false);
  });

  it('refuses an OWNERLESS app for a non-listed caller rather than matching undefined', () => {
    // `DROP_API_KEY` and `cli-local` principals are ownerless, and a monorepo
    // group child has no AppState.userId at all. `app.userId === auth.userId`
    // must not become true because both sides happen to be undefined.
    const auth = ctx({ userId: undefined as unknown as string });
    expect(canOpen(auth, { userId: undefined }, gated(['user-1']))).toBe(false);
  });

  it('refuses a scope-only agent credential with no role standing', () => {
    // An agent token is a deploy credential. Nothing about holding one says a
    // human is sitting behind a browser session for this app.
    const agent = ctx({ userId: 'user-9', role: 'none', kind: 'agent', authMethod: 'apikey' });
    expect(canOpen(agent, { userId: 'owner-1' }, gated(['user-1']))).toBe(false);
  });
});
