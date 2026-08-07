/**
 * Upload Deploy Type Definitions
 *
 * Types for deploying applications from an uploaded gzipped tarball
 * (PRD-039). The tarball itself has already been streamed to a local path by
 * the route before the service ever sees it.
 */

/** Request to deploy from a tarball already staged on disk. */
export interface UploadDeployRequest {
  appName: string;
  archivePath: string;
  userId?: string;
  /**
   * The credential that asked for this deploy, for guardrail keying — NOT for
   * authorization, which happened at the route or tool boundary. Absent when
   * DROP triggered the deploy itself.
   */
  principalId?: string;
  /**
   * Whether the CALLER is an agent credential, derived server-side from the
   * auth context — never read from a request body. Only consulted when the app
   * is new; a redeploy never changes it (SEC-11).
   */
  agentCaller?: boolean;
  /** Create as a throwaway app that reaps itself (Step 10). */
  ephemeral?: boolean;
  /** Requested lifetime; clamped by DROP_MAX_EPHEMERAL_TTL_MIN. */
  ttlMinutes?: number;
}

/**
 * Result of an accepted upload deploy. Callers correlate this with the
 * deploy-episodes API by polling for an episode whose `startedAt >=
 * acceptedAt` (see PRD-039's correlation contract) rather than plumbing a
 * first-class deployId through the event bus.
 */
export interface UploadDeployResult {
  app: string;
  acceptedAt: string;
  isNew: boolean;
}

/** Thrown when the request fails validation before any extraction is attempted. */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

/** Thrown when there isn't enough free disk space to land the extracted files. */
export class InsufficientDiskSpaceError extends Error {
  constructor(
    public readonly freeMb: number,
    public readonly requiredMb: number
  ) {
    super(`Insufficient disk space to deploy: ${Math.round(freeMb)} MB free, need ${requiredMb} MB`);
    this.name = 'InsufficientDiskSpaceError';
  }
}
