import { deployActorOf } from './deploy-actor';
import type { AuthContext } from './middleware/auth';

const ctx = (over: Partial<AuthContext>): AuthContext => ({
  userId: 'u-1',
  username: 'alice',
  role: 'user',
  authMethod: 'jwt',
  principalId: 'p-1',
  ...over,
});

describe('deployActorOf', () => {
  it('reads the principal and the acting human off the auth context', () => {
    expect(deployActorOf(ctx({}))).toEqual({ principalId: 'p-1', actorUserId: 'u-1', agent: false });
  });

  it('marks an agent token as an agent', () => {
    expect(deployActorOf(ctx({ kind: 'agent', authMethod: 'apikey' })).agent).toBe(true);
  });

  it('marks an OAuth session as an agent too: it is an autonomous caller', () => {
    expect(deployActorOf(ctx({ authMethod: 'oauth' })).agent).toBe(true);
  });

  it('an ordinary API key is not an agent', () => {
    expect(deployActorOf(ctx({ authMethod: 'apikey' })).agent).toBe(false);
  });

  it('is an anonymous, non-agent actor when auth is disabled', () => {
    expect(deployActorOf(undefined)).toEqual({ principalId: undefined, actorUserId: undefined, agent: false });
  });
});
