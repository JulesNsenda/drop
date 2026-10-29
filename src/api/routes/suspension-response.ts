/**
 * The 409 a route answers when the suspension refused the request, shared by
 * every route file that can meet one.
 *
 * A LEAF MODULE, deliberately - the same argument `access-limits.ts` and
 * `mail-quota.ts` make for themselves: a route importing another route is how
 * a require cycle starts, and `git-deploy.ts` had begun importing `apps.ts` for
 * this alone.
 */

import type { Context } from 'hono';
import { error } from '../types';
import type { AuthContext } from '../middleware/auth';
import type { AppSuspendedError } from '../platform-ops';

/**
 * 409 for a start the suspension refused. `APP_SUSPENDED` is its own code so a
 * client can tell it from a busy app: retrying will not help until an admin acts.
 * Only an admin is told the suspension store is the reason (as in `suspendedDto`).
 */
export function appSuspendedResponse(c: Context, err: AppSuspendedError) {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  return c.json(error(err.code, err.messageFor(auth?.role === 'admin')), 409);
}
