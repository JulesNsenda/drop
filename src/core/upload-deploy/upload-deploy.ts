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
import { getLogger } from '../../utils/logger';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { eventBus } from '../event-bus';

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
    const { appName, archivePath, userId } = request;

    if (!isValidAppName(appName)) {
      throw new UploadValidationError(`Invalid app name: ${appName}`);
    }

    this.activeUploads.add(appName);
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
      }

      await this.landFiles(stagingDir, destPath);

      const acceptedAt = new Date().toISOString();

      if (isNew) {
        eventBus.publish('app:detected', {
          name: appName,
          path: destPath,
          type: undefined,
          origin: 'upload',
        });
      } else {
        eventBus.publish('app:update', {
          name: appName,
          path: destPath,
          reason: 'upload deploy',
          bypassCooldown: true,
        });
      }

      logger.info(`Uploaded ${appName} (${isNew ? 'new' : 'redeploy'})`, 'UPLOAD-DEPLOY');

      return { app: appName, acceptedAt, isNew };
    } finally {
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
