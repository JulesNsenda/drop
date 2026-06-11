/**
 * Shared ownership/access checks for app-scoped routes.
 */

import { AuthContext } from './middleware/auth';
import { AppState } from '../managers/app/state-manager';

/**
 * Whether the current request may access an app: owns it, is an admin, or
 * auth is disabled platform-wide. Used by every app-scoped route so a user
 * cannot read or mutate another tenant's app, logs, or secrets (IDOR).
 */
export function canAccess(auth: AuthContext | undefined, app: Pick<AppState, 'userId'>): boolean {
  if (!auth) return true; // No auth enabled
  if (auth.role === 'admin') return true;
  return app.userId === auth.userId;
}
