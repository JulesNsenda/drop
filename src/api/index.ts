/**
 * REST API Module
 *
 * Exports all API components.
 */

export { ApiServer, createApiServer, type ApiServerConfig } from './server';
export * from './types';
export { HttpError, NotFoundError, ValidationError, ConflictError } from './middleware/error';
export {
  initializeAuth,
  authMiddleware,
  authenticateUser,
  createUser,
  createApiKey,
  setupMfa,
  enableMfa,
  disableMfa,
  completeMfaLogin,
  type AuthConfig,
  type AuthContext,
  type AuthenticateResult,
} from './middleware/auth';
