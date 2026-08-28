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
  it('will not compile with a missing policy — "no policy" is a MISSED LOOKUP here', () => {
    // Not a runtime assertion, and deliberately so. This function is reached
    // only through the forward_auth on a gated app's Caddy block, where an
    // absent policy means the config read failed on an app Caddy has already
    // said is gated — not "this app is not gated". An optional parameter
    // answering `true` for `undefined` would open every such app.
    // @ts-expect-error — the policy parameter is required by design.
    expect(() => canOpen(ctx({}), { userId: 'owner-1' })).toBeDefined();
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

  describe('credential class', () => {
    // `forward_auth` proxies the ORIGINAL request to the verify hop, so a
    // tenant-controlled Authorization / X-Api-Key header arrives with it
    // unless stripped by name in the generated Caddy block. A role alone does
    // not distinguish an agent token from a browser session.

    it('refuses an ADMIN-role API key', () => {
      const key = ctx({ userId: 'admin-1', role: 'admin', authMethod: 'apikey' });
      expect(canOpen(key, { userId: 'owner-1' }, gated([]))).toBe(false);
    });

    it('refuses the OWNER presenting an API key rather than a session', () => {
      // The scoped DROP_API_KEY that DROP injects into a tenant app resolves
      // to its owner's user id — so without this the app can open its own
      // owner's gate from inside the container.
      const key = ctx({ userId: 'owner-1', role: 'user', authMethod: 'apikey' });
      expect(canOpen(key, { userId: 'owner-1' }, gated([]))).toBe(false);
    });

    it('refuses an OAuth access token', () => {
      const oauth = ctx({ userId: 'user-1', role: 'user', authMethod: 'oauth' });
      expect(canOpen(oauth, { userId: 'owner-1' }, gated(['user-1']))).toBe(false);
    });

    it('refuses an agent-kind credential even on the jwt path', () => {
      const agent = ctx({ userId: 'user-1', role: 'user', authMethod: 'jwt', kind: 'agent' });
      expect(canOpen(agent, { userId: 'owner-1' }, gated(['user-1']))).toBe(false);
    });

    it('admits an ordinary interactive session', () => {
      expect(
        canOpen(ctx({ userId: 'user-1', authMethod: 'jwt' }), { userId: 'owner-1' }, gated(['user-1']))
      ).toBe(true);
    });
  });
});
