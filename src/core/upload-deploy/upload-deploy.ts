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
  UploadNotFoundError,
  UploadConflictError,
  InsufficientDiskSpaceError,
} from './upload-deploy.types';
import { isValidAppName } from '../../api/middleware/validate';
import { tryReserve, release, ownerOf, reservationPrincipal } from '../deploy-reservations';
import { isNewNameRefused } from '../app-names';
import { resolveGitBackedName } from '../git-backed';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, getAppConfigServiceOrNull } from '../../managers/app/app-config';
import { getPlatformOps, AppInProgressError, AppSuspendedError } from '../../api/platform-ops';
import { getSuspensionStore } from '../../managers/suspension';
import { getLogger } from '../../utils/logger';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { syncTree, DEFAULT_PRESERVE } from '../../utils/tree-sync';
import { eventBus } from '../event-bus';
import { captureBeforeRedeploy } from '../../managers/rollback';
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
    const {
      appName,
      archivePath,
      userId,
      callerIsAdmin,
      principalId,
      agentCaller,
      ephemeral,
      ttlMinutes,
    } = request;

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
    //
    // The name is first RESERVED (deploy-reservations, shared with git deploy's
    // create) by a check-and-insert with no await between them, so a second
    // create or upload of it, inside this server process, is refused BEFORE it
    // stages anything: both would land into the same folder, and the first to
    // finish would clear the guard under the other. The holder's own double
    // submit, the app's owner and an admin are told it is busy (409); anyone
    // else is answered as a foreign app, since a 409 would tell them someone
    // else is deploying there. Only this call's own reservation is released.
    const existingApp = getStateManager().getApp(appName);
    const conflict = (message: string): Error =>
      userId && !callerIsAdmin && existingApp?.userId !== userId
        ? new UploadNotFoundError(appName)
        : new UploadConflictError(message);
    const principal = reservationPrincipal(userId, principalId);
    if (!tryReserve(appName, principal)) {
      // The holder (a double submit), the app's owner and an admin may be told
      // it is busy; anyone else is answered as a foreign app.
      const mayKnow =
        !userId || callerIsAdmin || ownerOf(appName) === principal || existingApp?.userId === userId;
      throw mayKnow
        ? new UploadConflictError(`A deploy of '${appName}' is already in progress`)
        : new UploadNotFoundError(appName);
    }
    this.activeUploads.add(appName);
    try {
      // Ownership and "name is free", ahead of admitDeploy and extraction so a
      // refusal spends no quota and no work. The route preflight enforces the
      // same; this is the backstop for a caller that bypasses it or races it.
      // The role comes from the caller's credential (`callerIsAdmin`), not from
      // `userId`, which for an ownerless admin key is the key id and resolves to
      // no user. No userId means auth is off: there is no boundary to enforce.
      if (userId && !callerIsAdmin) {
        if (existingApp) {
          // Same rule as canAccess. Answered as an unknown app is.
          if (existingApp.userId !== userId) throw new UploadNotFoundError(appName);
        } else if (
          await isNewNameRefused(appName, {
            callerIsAdmin: false,
            appsDirectory: this.config.appsDirectory,
            stateManager: getStateManager(),
            appConfigService: getAppConfigServiceOrNull() ?? undefined,
          })
        ) {
          // "Not in state" is not "free": a folder-dropped app never is in state,
          // and registering over its folder would sync this caller's tree into it.
          // Nor is a name that is another app's group or container, or differs
          // from an existing name only in case.
          throw new UploadNotFoundError(appName);
        }
      }
      // An upload onto a git-backed app (or a child of a git-deployed group)
      // would prune its `.git` and sever it from its source; the route
      // preflight refuses it, and this is the backstop for a caller that
      // bypasses or races the route. Same wording, one deploy source per app.
      const gitBackedName = existingApp
        ? resolveGitBackedName(existingApp, getStateManager())
        : undefined;
      if (gitBackedName) {
        throw new UploadConflictError(
          `Application '${appName}' is deployed from git${
            gitBackedName === appName ? '' : ` (group '${gitBackedName}')`
          }; redeploy it from git instead of uploading`
        );
      }
      // A suspended app is refused HERE: before admitDeploy (which charges the
      // quota) and before anything is extracted or landed. After the ownership
      // checks above, so a caller who may not know the app is answered as for
      // an unknown one. A recreated name stays suspended (the store is name-keyed).
      const suspension = getSuspensionStore().refusalFor(appName);
      if (suspension) throw new AppSuspendedError(appName, suspension);
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
      release(appName, principal);
      throw err;
    }

    let stagingDir: string | undefined;
    // What THIS call wrote for a new app, so a failure can take back exactly
    // that (and never the folder, which may be someone else's).
    let registeredHere = false;
    let configWrittenHere = false;
    // Set by landFiles once THIS call is the one creating the folder.
    const landing = { created: false };
    let hadConfig = false;
    // The platform's claim on the app while its folder is written (redeploys).
    let releaseClaim: (() => void) | undefined;

    try {
      stagingDir = path.join(this.config.tempDirectory, `upload-${appName}-${Date.now()}`);

      const limits: TarExtractLimits = {
        maxUncompressedBytes: this.config.maxUncompressedBytes,
        maxEntries: this.config.maxEntries,
        timeoutMs: this.config.extractTimeoutMs,
      };

      // extractTarball rejects (and cleans up) empty archives, symlink/
      // hardlink/device entries, tar-slip, collisions, oversize/overcount,
      // non-gzip payloads, and any `.git` path component on its own —
      // nothing further to validate here (don't add a duplicate `.git` check
      // downstream of this call).
      await extractTarball(archivePath, stagingDir, limits);

      // Re-check disk space nearer to the write than the route's own
      // preflight: extraction itself consumes disk and time has passed.
      const disk = await hasEnoughDisk(this.config.appsDirectory);
      if (!disk.ok) {
        throw new InsufficientDiskSpaceError(disk.freeMb, getMinFreeDiskMb());
      }

      const stateManager = getStateManager();
      const destPath = path.join(this.config.appsDirectory, appName);

      // Extraction takes time, and everything decided before it was decided on
      // state that can have moved: someone registered this name meanwhile, or the
      // app changed hands. Deciding `isNew` afresh would turn a refused create into
      // an adoption, so a change of either is a conflict, not a new fact.
      const current = stateManager.getApp(appName);
      if (!!current !== !!existingApp || current?.userId !== existingApp?.userId) {
        throw conflict(`'${appName}' changed while the upload was being processed`);
      }
      const isNew = !current;
      // A non-admin create must not land over a folder that appeared meanwhile.
      // Admins keep adopting a folder they dropped themselves.
      const refuseExisting = isNew && !!userId && !callerIsAdmin;
      if (
        refuseExisting &&
        (await isNewNameRefused(appName, {
          callerIsAdmin: false,
          appsDirectory: this.config.appsDirectory,
          stateManager,
          appConfigService: getAppConfigServiceOrNull() ?? undefined,
        }))
      ) {
        throw new UploadNotFoundError(appName);
      }

      // Register (+ userId) atomically before files land - same ordering as
      // git-deploy, so a crash between register and landing still leaves the
      // app owned/attributed rather than landing anonymous, unregistered files.
      if (isNew) {
        await stateManager.registerApp(appName, destPath);
        registeredHere = true;
        if (userId) {
          await stateManager.updateApp(appName, { userId } as Record<string, unknown>);
        }
        // ONLY on first creation (SEC-11). A redeploy must never set this: it
        // is what exposes an app to automatic deletion, database included, and
        // one agent-assisted redeploy of a long-lived human-owned app would
        // otherwise flag it permanently.
        //
        // upsertSystemConfig, NOT updateConfig. This runs BEFORE the
        // app:detected handler creates the config (platform.ts), and
        // updateConfig writes nothing when none exists — it returns null,
        // which all four call sites here and in git-deploy ignored. So these
        // flags were dropped on precisely the path that sets them (new apps
        // only), leaving the ephemeral quota, the ephemeral reap and the idle
        // reaper's agentCreated filter inert in production. `path` rides
        // along so a config created here is never pathless if the deploy
        // dies before detection; app:detected upserts the same value.
        // upsertSystemConfig (not upsertConfig) because agentCreated/
        // ephemeral/expiresAt/ephemeralPrincipalId are SYSTEM_CONFIG_FIELDS.
        hadConfig = getAppConfigServiceOrNull()?.hasConfig(appName) ?? false;
        if (agentCaller) {
          configWrittenHere = true;
          await getAppConfigService().upsertSystemConfig(appName, {
            agentCreated: true,
            path: destPath,
          });
        }
        if (ephemeral) {
          configWrittenHere = true;
          const ttl = resolveTtlMinutes(ttlMinutes);
          await getAppConfigService().upsertSystemConfig(appName, {
            ephemeral: true,
            expiresAt: new Date(Date.now() + ttl * 60_000).toISOString(),
            ephemeralPrincipalId: principalId,
            path: destPath,
            // An ephemeral is by definition agent-scale throwaway work, so it
            // is reapable on idleness too — not only on its deadline.
            agentCreated: true,
          });
        }
      }

      // Held from before the snapshot to the end of the write: a build running
      // in the folder, or a restart, must not overlap either.
      if (!isNew) releaseClaim = await this.claimFolder(appName);

      if (!isNew) {
      // Rollback snapshot of the tree that is SERVING, before it is replaced
      // (#296). Best-effort by contract: it never throws, and a skipped or
      // failed snapshot never fails the deploy — it only means this redeploy
      // cannot be rolled back, which the rollback route reports as such.
        const snapshot = await captureBeforeRedeploy(appName);
        if (!snapshot.captured) {
          logger.info(`No rollback snapshot for ${appName}: ${snapshot.reason}`, 'UPLOAD-DEPLOY');
        }
      }

      await this.landFiles(stagingDir, destPath, refuseExisting, landing);

      // The write is done: give the claim back before publishing, or the
      // platform's own busy check would drop this method's event.
      releaseClaim?.();
      releaseClaim = undefined;

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
    } catch (err) {
      // A new app this call registered must not outlive its failure: an entry
      // with no files owns the name for the caller, and the next upload would
      // read it as an existing app of theirs. A folder this call itself began
      // creating is removed too, as git deploy does: landFiles flags that only
      // when it is the one making the folder, so a folder that was already there
      // (one that appeared meanwhile, or one an admin dropped and is adopting) is
      // left alone. A config that existed before this call is left too.
      if (registeredHere) {
        if (landing.created) {
          await fs.rm(path.join(this.config.appsDirectory, appName), { recursive: true, force: true }).catch(() => undefined);
        }
        await getStateManager().removeApp(appName).catch(() => undefined);
        if (configWrittenHere && !hadConfig) {
          await getAppConfigService().deleteConfig(appName).catch(() => undefined);
        }
      }
      throw err;
    } finally {
      releaseClaim?.();
      release(appName, principal);
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
   * Take the platform's claim on an existing app and confirm no build container
   * is alive in its folder, as git deploy does before it writes there. Refuses
   * with AppInProgressError (409) if either fails. Without platform operations
   * (no platform is wired) there is no builder to collide with and no claim.
   */
  private async claimFolder(appName: string): Promise<(() => void) | undefined> {
    const ops = getPlatformOps();
    if (!ops) return undefined;
    // A monorepo child is not written while its container re-expands (and the
    // reverse), the same rule git deploy applies.
    if (ops.isGroupBusy(appName)) throw new AppInProgressError(appName);
    // The platform counts an upload in flight as busy, which would refuse this
    // call's own claim. Unmark for the one synchronous step that takes it.
    this.activeUploads.delete(appName);
    let claim: (() => void) | null;
    try {
      claim = ops.tryReserveApp(appName);
    } finally {
      this.activeUploads.add(appName);
    }
    if (!claim) throw new AppInProgressError(appName);
    try {
      if (await ops.hasLiveBuildContainer(appName)) throw new AppInProgressError(appName);
    } catch (err) {
      claim();
      throw err;
    }
    return claim;
  }

  /**
   * Land the extracted staging tree at `destPath`. For a brand-new app,
   * try an atomic rename of the whole staging directory first (falling back
   * to a recursive copy on EXDEV — staging and apps directories on different
   * filesystems). For a redeploy over an existing app dir, sync the staged
   * tree over the target and then delete stale target entries that aren't
   * present in the staged tree, so nothing lingers from a previous upload.
   *
   * `node_modules` survives that prune (`DEFAULT_PRESERVE`): a tarball never
   * carries it, and deleting it used to pull a running app's dependencies out
   * from under it on every redeploy. Build output is NOT preserved — see the
   * note on `DEFAULT_PRESERVE` for why that is required rather than an
   * oversight.
   */
  private async landFiles(
    stagingDir: string,
    destPath: string,
    refuseExisting: boolean,
    landing?: { created: boolean }
  ): Promise<void> {
    const destExists = fssync.existsSync(destPath);
    // Last line of the "name is free" check: syncTree would merge into, and prune,
    // whatever is there.
    if (refuseExisting && destExists) throw new UploadNotFoundError(path.basename(destPath));

    if (!destExists) {
      try {
        await fs.rename(stagingDir, destPath);
        if (landing) landing.created = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // The copy below creates the folder, so a failure part-way leaves a
        // partial one that is ours to remove.
        if (landing) landing.created = true;
        // syncTree prunes as well as copies, where the old copy-only helper
        // did not. Harmless here: the prune only removes what the copy didn't
        // just land, and on a destination that didn't exist there is nothing
        // else. If residue somehow raced in between the existsSync above and
        // the failed rename, clearing it is what a fresh deploy should do.
        await syncTree(stagingDir, destPath, { preserve: DEFAULT_PRESERVE });
        return;
      }
    }

    await syncTree(stagingDir, destPath, { preserve: DEFAULT_PRESERVE });
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
