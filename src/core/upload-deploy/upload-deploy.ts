/**
 * Upload Deploy Service (PRD-039)
 *
 * Deploys an application from a gzipped tarball that has already been
 * streamed to disk by the route. Mirrors GitDeployService's landing pattern:
 * register the app (with userId) atomically before files land, guard the
 * watcher with an `activeUploads` set that plays the same role as
 * git-deploy's `activeClones`, and publish `app:detected` / `app:update`
 * directly instead of waiting on the file watcher — whose adaptive cooldown
 * (up to 120s) would swallow an agent's rapid fix -> redeploy loop, and whose
 * rename onto an existing app dir isn't atomic anyway.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { extractTarball, TarExtractLimits } from './tar-extract';
import {
  UploadDeployRequest,
  UploadDeployResult,
  UploadValidationError,
  InsufficientDiskSpaceError,
} from './upload-deploy.types';
import { isValidAppName } from '../../api/middleware/validate';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { getLogger } from '../../utils/logger';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { eventBus } from '../event-bus';
import { admitDeploy } from '../../managers/guardrail/deploy-breaker';
import {
  checkEphemeralQuota,
  resolveTtlMinutes,
  EphemeralQuotaError,
} from '../../managers/guardrail/ephemeral';

const logger = getLogger();

export interface UploadDeployServiceConfig {
  /** Directory apps are deployed into (the watched webapps directory). */
  appsDirectory: string;
  /** Directory used for extraction staging, outside the watched tree. */
  tempDirectory: string;
  /** Incremental cap on cumulative decompressed bytes per archive. */
  maxUncompressedBytes: number;
  /** Cap on the number of entries (files + directories) per archive. */
  maxEntries: number;
  /** Wall-clock budget for extracting a single archive, in milliseconds. */
  extractTimeoutMs: number;
}

export class UploadDeployService {
  private readonly config: UploadDeployServiceConfig;
  private activeUploads: Set<string> = new Set();

  constructor(config: UploadDeployServiceConfig) {
    this.config = config;
  }

  /** Check if an app currently has an upload deploy in flight. */
  isUploading(appName: string): boolean {
    return this.activeUploads.has(appName);
  }

  /** Deploy (or redeploy) an app from an already-staged tarball. */
  async deploy(request: UploadDeployRequest): Promise<UploadDeployResult> {
    const { appName, archivePath, userId, principalId, agentCaller, ephemeral, ttlMinutes } =
      request;

    if (!isValidAppName(appName)) {
      throw new UploadValidationError(`Invalid app name: ${appName}`);
    }

    // GUARDRAIL PRE-CHECK, before any expensive work.
    //
    // The platform's gates sit at the BUILD, which leaves everything up to it
    // unmetered: the archive is extracted and LANDED over the live app tree
    // before app:detected/app:update is ever published, so a refusal downstream
    // could not undo the write and never stopped the work. Worse, those writes
    // are inside the watched directory, so the watcher's debounced flush would
    // republish with no actor and launder the refused build into the automation
    // bucket.
    //
    // Records nothing against the breaker — that outcome is recorded once, by
    // the platform, for the episode this admits. It DOES spend quota, which is
    // counted on admission rather than on outcome.
    //
    // Marked in-flight BEFORE the await. `isUploading` is what the platform's
    // app:detected/app:update subscribers consult to drop watcher events mid
    // upload, and this method used to set it synchronously; awaiting first
    // would open a window where the deploy has begun and nothing says so.
    // Released again if admission refuses, since nothing was started.
    this.activeUploads.add(appName);
    try {
      const existingApp = getStateManager().getApp(appName);
      await admitDeploy(appName, !existingApp, { principalId, actorUserId: userId });

      // Ephemeral quota, checked here for the same reason the guardrail is:
      // everything below extracts and lands files, and a refusal afterwards
      // would not undo that. Only for a NEW app — a redeploy occupies no
      // additional slot.
      if (ephemeral && !existingApp) {
        const configs = getAppConfigService().getAllConfigs();
        const verdict = checkEphemeralQuota(
          configs
            .filter((c) => c.ephemeral)
            .map((c) => ({
              name: c.name,
              principalId: c.ephemeralPrincipalId,
              userId: getStateManager().getApp(c.name)?.userId,
              expiresAt: c.expiresAt ?? '',
            })),
          { principalId, userId },
          Date.now()
        );
        if (!verdict.allowed) throw new EphemeralQuotaError(verdict.reason ?? 'Quota exceeded');
      }
    } catch (err) {
      this.activeUploads.delete(appName);
      throw err;
    }

    let stagingDir: string | undefined;

    try {
      stagingDir = path.join(this.config.tempDirectory, `upload-${appName}-${Date.now()}`);

      const limits: TarExtractLimits = {
        maxUncompressedBytes: this.config.maxUncompressedBytes,
        maxEntries: this.config.maxEntries,
        timeoutMs: this.config.extractTimeoutMs,
      };

      // extractTarball rejects (and cleans up) empty archives, symlink/
      // hardlink/device entries, tar-slip, collisions, oversize/overcount,
      // and non-gzip payloads on its own — nothing further to validate here.
      await extractTarball(archivePath, stagingDir, limits);

      // Re-check disk space nearer to the write than the route's own
      // preflight: extraction itself consumes disk and time has passed.
      const disk = await hasEnoughDisk(this.config.appsDirectory);
      if (!disk.ok) {
        throw new InsufficientDiskSpaceError(disk.freeMb, getMinFreeDiskMb());
      }

      const stateManager = getStateManager();
      const isNew = !stateManager.hasApp(appName);
      const destPath = path.join(this.config.appsDirectory, appName);

      // Register (+ userId) atomically before files land - same ordering as
      // git-deploy, so a crash between register and landing still leaves the
      // app owned/attributed rather than landing anonymous, unregistered files.
      if (isNew) {
        await stateManager.registerApp(appName, destPath);
        if (userId) {
          await stateManager.updateApp(appName, { userId } as Record<string, unknown>);
        }
        // ONLY on first creation (SEC-11). A redeploy must never set this: it
        // is what exposes an app to automatic deletion, database included, and
        // one agent-assisted redeploy of a long-lived human-owned app would
        // otherwise flag it permanently.
        if (agentCaller) {
          await getAppConfigService().updateConfig(appName, { agentCreated: true });
        }
        if (ephemeral) {
          const ttl = resolveTtlMinutes(ttlMinutes);
          await getAppConfigService().updateConfig(appName, {
            ephemeral: true,
            expiresAt: new Date(Date.now() + ttl * 60_000).toISOString(),
            ephemeralPrincipalId: principalId,
            // An ephemeral is by definition agent-scale throwaway work, so it
            // is reapable on idleness too — not only on its deadline.
            agentCreated: true,
          });
        }
      }

      await this.landFiles(stagingDir, destPath);

      const acceptedAt = new Date().toISOString();

      // Files are landed - clear the guard *before* publishing. The
      // platform's app:detected/app:update subscribers consult isUploading
      // the same way they consult git-deploy's isCloning (see platform.ts);
      // publishing while still marked "uploading" would have this method's
      // own event dropped by its own guard. Mirrors GitDeployService's
      // "clone complete - allow watcher to detect" ordering (activeClones is
      // cleared before its deterministic publish too).
      this.activeUploads.delete(appName);

      if (isNew) {
        eventBus.publish('app:detected', {
          name: appName,
          path: destPath,
          type: undefined,
          origin: 'upload',
          principalId,
          actorUserId: userId,
        });
      } else {
        // The REDEPLOY branch, and the one an agent loop actually rides: fix,
        // re-upload, fail, repeat. Leaving the actor off here would have left
        // the guardrail keying every retry as anonymous automation.
        eventBus.publish('app:update', {
          name: appName,
          path: destPath,
          reason: 'upload deploy',
          bypassCooldown: true,
          principalId,
          actorUserId: userId,
        });
      }

      logger.info(`Uploaded ${appName} (${isNew ? 'new' : 'redeploy'})`, 'UPLOAD-DEPLOY');

      return { app: appName, acceptedAt, isNew };
    } finally {
      // Idempotent: already cleared above on the success path. Still needed
      // here for the failure path (extraction/disk-check/landFiles threw
      // before reaching the clear above).
      this.activeUploads.delete(appName);
      if (stagingDir) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Land the extracted staging tree at `destPath`. For a brand-new app,
   * try an atomic rename of the whole staging directory first (falling back
   * to a recursive copy on EXDEV — staging and apps directories on different
   * filesystems). For a redeploy over an existing app dir, sync the staged
   * tree over the target and then delete stale target entries that aren't
   * present in the staged tree, so nothing lingers from a previous upload.
   */
  private async landFiles(stagingDir: string, destPath: string): Promise<void> {
    const destExists = fssync.existsSync(destPath);

    if (!destExists) {
      try {
        await fs.rename(stagingDir, destPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await this.copyTree(stagingDir, destPath);
        return;
      }
    }

    await this.copyTree(stagingDir, destPath);
    await this.pruneStale(stagingDir, destPath);
  }

  /** Recursively copy every file/directory from srcDir into destDir. */
  private async copyTree(srcDir: string, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destEntryPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        // A previous deploy may have left a plain file at this name; clear
        // it so mkdir doesn't collide with a same-named non-directory.
        const existing = await this.lstatOrNull(destEntryPath);
        if (existing && !existing.isDirectory()) {
          await fs.rm(destEntryPath, { force: true });
        }
        await this.copyTree(srcPath, destEntryPath);
      } else if (entry.isFile()) {
        const existing = await this.lstatOrNull(destEntryPath);
        if (existing && existing.isDirectory()) {
          await fs.rm(destEntryPath, { recursive: true, force: true });
        }
        await fs.copyFile(srcPath, destEntryPath);
      }
      // tar-extract never writes symlinks/devices/etc, so the staged tree
      // has no other entry kinds to copy.
    }
  }

  /** Delete anything under destDir that isn't present in the staged srcDir. */
  private async pruneStale(srcDir: string, destDir: string): Promise<void> {
    const [srcEntries, destEntries] = await Promise.all([
      fs.readdir(srcDir, { withFileTypes: true }),
      fs.readdir(destDir, { withFileTypes: true }),
    ]);
    const srcByName = new Map(srcEntries.map((e) => [e.name, e]));

    for (const destEntry of destEntries) {
      const srcEntry = srcByName.get(destEntry.name);
      if (!srcEntry) {
        await fs.rm(path.join(destDir, destEntry.name), { recursive: true, force: true });
        continue;
      }
      if (destEntry.isDirectory() && srcEntry.isDirectory()) {
        await this.pruneStale(path.join(srcDir, destEntry.name), path.join(destDir, destEntry.name));
      }
    }
  }

  private async lstatOrNull(p: string): Promise<fssync.Stats | null> {
    try {
      return await fs.lstat(p);
    } catch {
      return null;
    }
  }
}

// Singleton
let instance: UploadDeployService | null = null;

export function getUploadDeployService(config?: UploadDeployServiceConfig): UploadDeployService {
  if (!instance) {
    if (!config) {
      throw new Error('UploadDeployService config required on first call');
    }
    instance = new UploadDeployService(config);
  }
  return instance;
}

export function resetUploadDeployService(): void {
  instance = null;
}
