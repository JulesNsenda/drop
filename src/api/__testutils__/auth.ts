/**
 * Auth test utilities.
 * Provides getTestToken() to get a session JWT without dealing with
 * the authenticateUser discriminated union in every test file.
 */

import { authenticateUser } from '../middleware/auth';

/**
 * Authenticate a user and return the session JWT.
 * Throws if authentication does not return status 'ok'
 * (wrong credentials, disabled account, or MFA required).
 */
export async function getTestToken(username: string, password: string): Promise<string> {
  const result = await authenticateUser(username, password);
  if (result.status !== 'ok') {
    throw new Error(`getTestToken: expected status 'ok', got '${result.status}' for user '${username}'`);
  }
  return result.token;
}
