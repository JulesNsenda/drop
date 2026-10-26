/**
 * Toolchain id: which Node a `node_modules` tree was built for.
 *
 * The id is what makes a native addon LOAD, not which image or version string
 * built it: `node-abi-<modules>-<platform>-<arch>-<libc>`. formatToolchainId is
 * the ONE producer of that format, and toolchainIdFor is the ONE producer of an
 * id for a build. The build uses it today; start and boot will (plan items 3
 * and 4), so two sites can never disagree about what "the same toolchain"
 * means.
 *
 *  - isolation=docker: from a static table keyed by the node image TAG major
 *    (toolchainIdFromImage). A digest refresh or DROP_DISABLE_IMAGE_PINNING
 *    changes nothing, because the digest is stripped before the lookup.
 *  - isolation=none: probed through the exec env tenants use
 *    (probeHostToolchainId, cached briefly), not taken from this process's
 *    `process.versions`.
 *
 * `null` always means UNKNOWN (no ABI entry, probe failed): callers must then
 * do today's thing — no move, no stamp (and the marker is dropped, see
 * ensureFreshNodeModules).
 *
 * The marker `node_modules/.drop-toolchain` is ADVISORY and tenant-forgeable:
 * forging it only affects the tenant's own rebuild decision. checkTree reads it
 * through the hardened tenant-file helpers and never echoes its content.
 *
 * What a stamp MEANS: this build installed the tree from empty (no node_modules,
 * or the old one parked) with this id, or found it already `match` — judged
 * right before the install runs (beforeInstall), after the drop.yaml hooks, so a
 * hook that put a tree back cannot get it stamped. A tree the build merely
 * installed over (`refused`, `unmarked`) is never stamped.
 *
 * Invariant: after a SUCCESSFUL build the marker is this build's id, absent, or a
 * refused marker (a link, FIFO or oversize file) that is never trusted; and a
 * parked tree is retired, even when the install was then skipped (a hook put
 * back a tree that reads `match`, which the build keeps). After a FAILED or
 * cancelled build, a parked tree is restored whole, marker included. Marker
 * removals (unknown id, or no JS install to follow) and a tree installed from
 * empty are NOT undone; they only ever leave the tree `unmarked` or stamped by
 * the build that made it, which the next build reconciles.
 *
 * The parked tree is the ONLY copy of the previous dependencies, so it lives in a
 * per-source-path slot (see parkedTreePaths) that a crash, a failed restore or a
 * failed retirement cannot lose: every build, and every boot, first restores the
 * slot for its own path (restoreParkedTree) before anything is deleted.
 */

import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { BuildContext, DependencySettle } from './builder.types';
import type { AppType } from '../detector/detector.types';
import { executeCommand } from './strategies/base';
import { NODE_MODULES_BUILD_TYPES } from './node-types';
import { selectBuildImage } from '../../managers/runtime/container-config';
import {
  NODE_MODULES_DIR,
  moveTenantDirIn,
  moveTenantDirOut,
  readTenantText,
  removeTenantPath,
  writeTenantFile,
} from '../../utils/tenant-file';
import { chmodDirNoFollow } from '../../utils/safe-open';

/** Marker file inside node_modules; its validity is exactly the tree's lifetime. */
export const TOOLCHAIN_MARKER = '.drop-toolchain';

/** Far larger than any valid id; a bigger marker is refused, not read. */
const MARKER_MAX_BYTES = 256;

/** Bound for the none-mode probe: it only prints one JSON line. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * How long a successful probe is trusted. Short on purpose: a host Node upgrade
 * is picked up by the next deploy without a platform restart.
 */
const PROBE_CACHE_TTL_MS = 60_000;

export interface ToolchainParts {
  modules: string;
  platform: string;
  arch: string;
  libc: string;
}

export function formatToolchainId(parts: ToolchainParts): string {
  return `node-abi-${parts.modules}-${parts.platform}-${parts.arch}-${parts.libc}`;
}

/**
 * node image tag major -> NODE_MODULE_VERSION. Add the entry in the same change
 * that adds a node image to container-config (a test fails otherwise).
 */
export const NODE_IMAGE_ABI: Record<string, string> = {
  '20': '115',
  '22': '127',
  '24': '137',
};

const NODE_IMAGE_RE = /^(?:docker\.io\/library\/)?node:(\d+)(?:\.\d+){0,2}(?:-([a-z0-9._-]+))?$/;

/**
 * Id for a build/run container image, or null when it is not a node image or
 * its major has no table entry. The build container runs on this host, so the
 * arch is this process's; libc is musl for an alpine variant, else glibc.
 */
export function toolchainIdFromImage(image: string): string | null {
  const match = NODE_IMAGE_RE.exec(image.split('@')[0]);
  if (!match) return null;
  const modules = NODE_IMAGE_ABI[match[1]];
  if (!modules) return null;
  const libc = (match[2] ?? '').includes('alpine') ? 'musl' : 'glibc';
  return formatToolchainId({ modules, platform: 'linux', arch: process.arch, libc });
}

/**
 * Under docker, the toolchain of every tree built before the marker existed:
 * the tenant image then was node:20-slim. The boot backfill stamps only trees
 * it can vouch for, so it stamps nothing when the current image differs.
 */
export const PRE_MARKER_DOCKER_TOOLCHAIN = toolchainIdFromImage('node:20-slim');

// Single quotes only and no `$`/backtick/backslash: the same string has to
// survive both /bin/sh and cmd.exe double-quoting.
const PROBE_SCRIPT =
  'JSON.stringify({modules:process.versions.modules,platform:process.platform,' +
  'arch:process.arch,libc:process.platform===\'linux\'?' +
  '(process.report.getReport().header.glibcVersionRuntime?\'glibc\':\'musl\'):\'none\'})';

let cachedHost: { id: string; expiresAt: number } | null = null;
let inflightProbe: Promise<string | null> | null = null;
// Bumped by every reset: a probe that started before a reset must not write its
// result into (or clear the in-flight slot of) the world after it.
let probeGeneration = 0;

/** Drop the cached probe success and any in-flight probe (platform stop, tests). */
export function resetToolchainProbeCache(): void {
  cachedHost = null;
  inflightProbe = null;
  probeGeneration++;
}

type CommandRunner = typeof executeCommand;

function isToken(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value);
}

async function runHostProbe(cwd: string, run: CommandRunner): Promise<string | null> {
  try {
    const result = await run(
      `node -p "${PROBE_SCRIPT}"`,
      cwd,
      // cmd.exe searches the cwd before PATH for `node`; the cwd is a platform
      // dir, but never let the lookup depend on what sits in it.
      process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {},
      undefined,
      undefined,
      PROBE_TIMEOUT_MS
    );
    if (result.exitCode !== 0) {
      console.warn(`[toolchain] node probe exited with code ${result.exitCode}`);
      return null;
    }
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[toolchain] node probe returned an unexpected result');
      return null;
    }
    const { modules, platform, arch, libc } = parsed as Record<string, unknown>;
    if (
      !isToken(modules, /^\d+$/) ||
      !isToken(platform, /^[a-z0-9]+$/) ||
      !isToken(arch, /^[a-z0-9]+$/) ||
      !isToken(libc, /^[a-z0-9]+$/)
    ) {
      console.warn('[toolchain] node probe returned an unexpected result');
      return null;
    }
    return formatToolchainId({ modules, platform, arch, libc });
  } catch (err) {
    console.warn(`[toolchain] node probe failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Id of the `node` a PM2-run app would get (isolation=none): the PATH node, run
 * through executeCommand's sanitized env, the same lookup PM2's
 * `/bin/sh -c exec node` does. `cwd` MUST be a platform-owned directory (never
 * os.tmpdir() or a tenant path). Concurrent calls share one probe; a success is
 * cached for PROBE_CACHE_TTL_MS; a failure is null (with a warning), is never
 * cached, and is retried by the next call. `run` is injectable for tests.
 */
export function probeHostToolchainId(
  cwd: string,
  run: CommandRunner = executeCommand
): Promise<string | null> {
  if (cachedHost && cachedHost.expiresAt > Date.now()) return Promise.resolve(cachedHost.id);
  if (!inflightProbe) {
    const generation = probeGeneration;
    const probe: Promise<string | null> = runHostProbe(cwd, run)
      .then((id) => {
        if (id && generation === probeGeneration) {
          cachedHost = { id, expiresAt: Date.now() + PROBE_CACHE_TTL_MS };
        }
        return id;
      })
      .finally(() => {
        if (inflightProbe === probe) inflightProbe = null;
      });
    inflightProbe = probe;
  }
  return inflightProbe;
}

/**
 * The ONE producer of a build's toolchain id.
 *  - docker: the id of the image the build container runs (selectBuildImage).
 *  - none: the probed host `node`.
 * Both only for NODE_MODULES_BUILD_TYPES (the types whose strategy installs and
 * stamps node_modules), checked BEFORE the isolation branch so the two modes
 * agree: any other type gets null, without spawning a process or reading an
 * image. `probeCwd` is the platform-owned directory the host probe runs in.
 * `run` is injectable for tests.
 */
export async function toolchainIdFor(
  isolation: 'docker' | 'none',
  appType: AppType,
  probeCwd: string,
  run?: CommandRunner
): Promise<string | null> {
  if (!NODE_MODULES_BUILD_TYPES.includes(appType)) return null;
  if (isolation === 'docker') return toolchainIdFromImage(selectBuildImage(appType));
  return probeHostToolchainId(probeCwd, run);
}

/**
 * - `no-modules`: the tree has no node_modules directory.
 * - `match`: stamped with this id.
 * - `stale`: stamped with a different one.
 * - `unmarked`: node_modules exists, no marker file.
 * - `refused`: something there that is not vouched for (symlinked
 *   node_modules, linked/FIFO/oversize/unreadable marker).
 */
export type TreeState = 'no-modules' | 'match' | 'stale' | 'unmarked' | 'refused';

/** Classify `<treeRoot>/node_modules` against `id`. Never throws, never logs marker content. */
export async function checkTree(treeRoot: string, id: string): Promise<TreeState> {
  const read = await readTenantText(
    treeRoot,
    path.join(NODE_MODULES_DIR, TOOLCHAIN_MARKER),
    MARKER_MAX_BYTES
  );
  if (read.kind === 'absent') return read.at === 'parent' ? 'no-modules' : 'unmarked';
  if (read.kind === 'refused') return 'refused';
  return read.text === id ? 'match' : 'stale';
}

const JS_INSTALL_RE = /^(?:npm\s+(?:ci|install|i)|pnpm\s+(?:install|i)|yarn)(?:\s|$)/;

/** `npm i -g x`, `--global`, `--location=global`: installs outside the app tree. */
const GLOBAL_INSTALL_RE = /(?:^|\s)(?:-g|--global|--location(?:=|\s+)global)(?:\s|$)/;

/** `npm ci --prefix x`, `pnpm i -C x` / `--dir x`, `yarn --cwd x`: installs into another folder. */
const ELSEWHERE_INSTALL_RE = /(?:^|\s)(?:--prefix|-C|--dir|--cwd)(?:=|\s|$)/;

/**
 * True only when the command LEADS with a JS package-manager install. A chained
 * `cd x && npm ci`, python/go/make installs and `npm run build` are not: the
 * platform cannot tell they rebuild the root node_modules, so it never wipes
 * or stamps for them. A global install is not one either, and bare `yarn` (alone
 * or followed only by flags, `yarn --frozen-lockfile`) IS the install. An install
 * pointed at another folder (`--prefix`, `-C`, `--dir`, `--cwd`) is custom too:
 * it never rebuilds the root node_modules.
 *
 * Only the LEADING segment of a chain (up to the first `&&`, `||`, `;` or `|`) is
 * judged: `npm ci && npm i -g x` still leads with a project install, while
 * `npm i -g pnpm && pnpm i` leads with a global one and so stays custom.
 */
export function isJsInstallCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  const lead = trimmed.split(/&&|\|\||;|\|/)[0].trim();
  if (!JS_INSTALL_RE.test(trimmed) || GLOBAL_INSTALL_RE.test(lead)) return false;
  if (ELSEWHERE_INSTALL_RE.test(lead)) return false;
  if (/^yarn(?:\s|$)/.test(trimmed)) {
    // `yarn build` is a script run, not an install: after `yarn` only `install`
    // or flags may follow.
    const args = lead.slice('yarn'.length).trim().split(/\s+/).filter(Boolean);
    return args.length === 0 || args[0] === 'install' || args.every((a) => a.startsWith('-'));
  }
  return true;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

/** Existence only (lstat, no read, no follow): a link still counts as "there is a lockfile". */
async function hasLockfile(treeRoot: string): Promise<boolean> {
  for (const name of LOCKFILES) {
    try {
      await fs.lstat(path.join(treeRoot, name));
      return true;
    } catch {
      // Not there (or unreadable): try the next name. This only feeds a
      // warning line, so "cannot tell" safely reads as "no lockfile".
    }
  }
  return false;
}

/**
 * True when this build is certain to run a JS package-manager install: install
 * not preset to skip, and the install command is either unset with the strategy
 * about to choose one (`strategyWillChooseJsInstall`), or leads with a JS
 * install. Custom installs (`make deps`, `cd x && npm ci`) are never touched.
 */
function jsInstallWillRun(context: BuildContext, strategyWillChooseJsInstall: boolean): boolean {
  if (context.config.skipInstall) return false;
  const { installCommand } = context.config;
  return installCommand ? isJsInstallCommand(installCommand) : strategyWillChooseJsInstall;
}

/**
 * Directory under `<dropRoot>/data/temp` that holds one aside dir per app. The
 * leading dot cannot be an app name (APP_NAME_RE in utils/upload-paths.ts), so
 * it can never collide with the bare-app-name staging dirs beside it.
 */
export const NODE_MODULES_ASIDE_DIR = '.node-modules-aside';

/**
 * Remove a platform-owned aside path. It sits outside the tenant tree, so plain
 * fs.rm is right for the removal and is tried FIRST. Only when it fails with
 * EACCES/EPERM (a tenant-made read-only directory) is every directory made u+rwx
 * by a walk that changes each one through a no-follow handle (chmodDirNoFollow:
 * a link is neither chmod'd nor descended into, even one swapped in mid-walk at
 * the last component; a swapped PARENT is the residual, covered by the
 * no-tenant-writer precondition, which holds because the aside dir is outside
 * the tree), and the rm
 * is retried once. Returns whether the tree is gone; never throws, and logs only
 * a generic line (no path).
 */
export async function removeAsideDir(aside: string): Promise<boolean> {
  const makeWritable = async (entry: string): Promise<void> => {
    if (!(await chmodDirNoFollow(entry))) return;
    for (const child of await fs.readdir(entry)) {
      await makeWritable(path.join(entry, child));
    }
  };
  try {
    try {
      await fs.rm(aside, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw err;
    }
    await makeWritable(aside).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    });
    await fs.rm(aside, { recursive: true, force: true });
    return true;
  } catch {
    console.warn('[toolchain] could not remove a moved-aside node_modules');
    return false;
  }
}

const PARKED_NAME = 'parked';
// A file in the slot written by commit() BEFORE it retires `parked/`: while it
// exists, a `parked/` beside it belongs to a build that SUCCEEDED and must be
// discarded, never restored.
const RETIRED_NAME = 'retired';
const TRASH_PREFIX = 'trash-';

/**
 * Where a build's previous node_modules is parked: ONE slot per source path,
 * `<asideRoot>/<first 16 hex of sha256(path.resolve(appPath))>/`, holding
 * `parked/` (the only copy of the previous tree) and any `trash-<uuid>/` dirs
 * (trees on their way to deletion). The slot is a pure function of the build's
 * own appPath, so no host path is ever read back off disk, and a zero-downtime
 * release build (a different appPath per deploy) can never recover or disturb
 * another release's tree. The ONE producer of the slot name: the build and the
 * boot restore both go through here, so they cannot disagree about which slot
 * belongs to a tree. The resolve is lexical (no realpath, nothing is read).
 */
export function parkedTreePaths(
  appPath: string,
  asideRoot: string
): { slot: string; parked: string } {
  const key = createHash('sha256').update(path.resolve(appPath)).digest('hex').slice(0, 16);
  const slot = path.join(asideRoot, key);
  return { slot, parked: path.join(slot, PARKED_NAME) };
}

/**
 * Put `appPath`'s own parked tree back (a crash between the move and the
 * settle, or a restore that failed). Only the slot for `appPath` is looked at.
 *  - `none`: nothing parked.
 *  - `restored`: whatever was at node_modules (a partial install) was renamed
 *    out to the slot's trash and the parked tree renamed in. Nothing is deleted
 *    before the original is back; the trash is removed best-effort.
 *  - `failed`: parked is still where it was, to be retried.
 * Never throws, logs only a generic line. Used by every build (before it
 * classifies the tree) and by the platform at boot (before any app starts).
 *
 * PRECONDITION: no build of this app is running (the tenant-file helpers' no
 * tenant-writer rule, plus a live build owns the slot).
 */
export async function restoreParkedTree(
  appPath: string,
  asideRoot: string
): Promise<'none' | 'restored' | 'failed'> {
  const { slot, parked } = parkedTreePaths(appPath, asideRoot);
  const retired = path.join(slot, RETIRED_NAME);
  const gone = (err: unknown): boolean => {
    // ENOTDIR: a component of the aside root is not a directory, so nothing can
    // be there.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  };
  try {
    await fs.lstat(parked);
  } catch (err) {
    if (!gone(err)) return 'failed';
    // A commit that finished its retire but not its cleanup leaves the marker
    // alone; clear it so it can never vouch for a LATER parked tree.
    try {
      await fs.unlink(retired);
    } catch (unlinkErr) {
      if (!gone(unlinkErr)) return 'failed';
    }
    return 'none';
  }
  const trash = path.join(slot, `${TRASH_PREFIX}${randomUUID()}`);
  let isRetired = true;
  try {
    await fs.lstat(retired);
  } catch (err) {
    if (!gone(err)) return 'failed';
    isRetired = false;
  }
  if (isRetired) {
    // The build that parked this tree succeeded: discard, never restore. The
    // marker goes only once `parked/` has.
    try {
      await fs.rename(parked, trash);
      await fs.unlink(retired);
    } catch {
      console.warn('[toolchain] could not discard a retired node_modules');
      return 'failed';
    }
    await removeAsideDir(trash);
    return 'none';
  }
  if (!(await moveTenantDirIn(appPath, NODE_MODULES_DIR, parked, trash))) {
    console.warn('[toolchain] could not restore a parked node_modules');
    return 'failed';
  }
  await removeAsideDir(trash);
  return 'restored';
}

/**
 * Sweep an app's aside root, best-effort: every `trash-*` in every slot, and
 * nothing else. A `parked/` is NEVER removed here, not even another slot's: it
 * may be the only copy of a source path's tree, waiting for that path's next
 * build or the boot restore (a release build of the same app has a different
 * slot). Another slot's `parked/` makes the result not clean. Returns whether
 * nothing but `ownSlot`'s own parked tree was left behind; a missing root is
 * clean.
 *
 * PRECONDITION: no OTHER build of this app is running, because its trash is
 * swept as a leftover. The platform's appsInProgress is the guard; the
 * BUILD_IN_PROGRESS refusal in BuilderService.build() is only a backstop for
 * these slots (by the time it fires, the platform has already discarded the
 * other build's deploy target).
 */
async function sweepAside(asideRoot: string, ownSlot: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(asideRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  let clean = true;
  for (const entry of entries) {
    const slot = path.join(asideRoot, entry);
    let inside: string[];
    try {
      inside = await fs.readdir(slot);
    } catch (err) {
      // A stray file directly under the root is no slot and holds no tree.
      const stray = (err as NodeJS.ErrnoException).code === 'ENOTDIR';
      if (!stray || !(await removeAsideDir(slot))) clean = false;
      continue;
    }
    for (const name of inside) {
      if (name.startsWith(TRASH_PREFIX)) {
        if (!(await removeAsideDir(path.join(slot, name)))) clean = false;
      } else if (slot !== ownSlot && name !== RETIRED_NAME) {
        clean = false;
      }
    }
  }
  return clean;
}

/**
 * The handle ensureFreshNodeModules returns. A class private to this module so
 * stampToolchain can tell a handle this module made from anything else
 * (`instanceof`), and so the stamping decision is one field only beforeInstall
 * can set.
 */
class ToolchainDeps implements DependencySettle {
  private stampable = false;

  /**
   * `stampableBefore`: this build installs from empty (no tree, or one parked
   * or removed) or over a `match`. `parkedAt`: where a tree was parked, or null.
   */
  constructor(
    private readonly context: BuildContext,
    private readonly stampableBefore: boolean,
    private parkedAt: { slot: string; parked: string } | null
  ) {}

  /** Whether stampToolchain may stamp; only true after beforeInstall said so. */
  get mayStamp(): boolean {
    return this.stampable;
  }

  /**
   * Decided HERE, right before the install runs and after the drop.yaml hooks:
   * a hook may have put a tree back (a cache restore). Stampable only if it was
   * before AND the tree is still `no-modules` or `match` now; an `unmarked`,
   * `stale` or `refused` tree a hook left would be installed over, not from empty.
   */
  async beforeInstall(): Promise<void> {
    const id = this.context.toolchainId;
    if (!this.stampableBefore || !id) return;
    const now = await checkTree(this.context.appPath, id);
    this.stampable = now === 'no-modules' || now === 'match';
  }

  /**
   * Retire the parked tree. First the slot's `retired` marker is written, so
   * from then on recovery DISCARDS `parked/` instead of restoring it; then
   * `parked/` is renamed to a trash dir in the same slot (a metadata
   * operation) and removed, and the marker goes. Nothing is ever deleted from
   * `parked/` in place, so a half-deleted tree can never be restored over this
   * build's good one. RESIDUAL: if the marker write AND the rename both fail,
   * `parked/` survives whole and the next build restores the OLD tree, intact.
   */
  async commit(): Promise<void> {
    if (!this.parkedAt) return;
    const { slot, parked } = this.parkedAt;
    this.parkedAt = null;
    const retired = path.join(slot, RETIRED_NAME);
    await fs.writeFile(retired, '', { mode: 0o600 }).catch(() => undefined);
    const trash = path.join(slot, `${TRASH_PREFIX}${randomUUID()}`);
    try {
      await fs.rename(parked, trash);
    } catch {
      console.warn('[toolchain] could not retire a moved-aside node_modules');
      return;
    }
    await fs.unlink(retired).catch(() => undefined);
    await removeAsideDir(trash);
  }

  /**
   * Put the parked tree back through the same rename-out/rename-in helper
   * recovery uses; throws generically (parked kept in place) if it cannot.
   */
  async rollback(): Promise<void> {
    if (!this.parkedAt) return;
    const { slot, parked } = this.parkedAt;
    this.parkedAt = null;
    const trash = path.join(slot, `${TRASH_PREFIX}${randomUUID()}`);
    if (!(await moveTenantDirIn(this.context.appPath, NODE_MODULES_DIR, parked, trash))) {
      throw new Error('could not restore node_modules after the build failed');
    }
    await removeAsideDir(trash);
  }
}

/**
 * The dependency step: runs BEFORE the drop.yaml preBuild hooks (a strategy's
 * `prepareDependencies`), so a hook can never touch a tree that is about to be
 * replaced. It also runs before any lockfile-hash skip decision: the
 * lockfile-hash marker lives inside node_modules and moves with it.
 *
 * It returns the handle BuilderService.build() settles once the build ends
 * (see DependencySettle); nothing here throws after a move, so a moved tree
 * always reaches that handle.
 *
 * FIRST of all, before any classification and whatever the id or the install
 * command, the build's OWN slot is recovered (restoreParkedTree): a parked tree
 * left by a crash, or by a restore that failed, goes back before anything else
 * can delete it. A recovery that fails THROWS a generic error with nothing
 * deleted or moved. Then every other slot and every `trash-*` is swept
 * best-effort (see sweepAside: one build per app at a time); if a move turns out
 * to be needed and the sweep left anything behind, that throws generically too,
 * which bounds the aside to one parked tree plus one unremovable leftover.
 *
 * With a known id and a JS install certain to follow (`jsInstallWillRun`), by
 * the tree's state:
 *  - `stale` (another toolchain) or `unmarked` (no marker: a failed stamp, or a
 *    tree from before stamping existed): PARKED in this build's slot under
 *    `context.nodeModulesAsideDir`, so the install starts from empty and the
 *    stamp that follows means what it says. Rolled back (restored whole,
 *    marker included) if the build fails or is cancelled; retired on success.
 *    When there is no aside dir, or the rename fails with EXDEV, the tree is
 *    removed in place instead (logged; a failed build then cannot restore it).
 *    Any other rename failure, or a refused removal, THROWS a generic error and
 *    leaves the tree untouched: a stale-ABI tree must not be served, and an
 *    unmovable one must not be silently destroyed.
 *  - `no-modules`: nothing to do; the install starts from empty by itself.
 *  - `match`: untouched.
 *  - `refused` (a tenant-made link, an unreadable marker): never moved and never
 *    stamped.
 * Whether the build may stamp is decided by the handle's beforeInstall, for
 * `no-modules`, `match` and a parked tree, if the tree still reads that way once
 * the hooks have run.
 *
 * Without a JS install to follow: a `stale` tree loses ONLY its marker, so it
 * reads `unmarked` rather than keeping a stale claim. With an UNKNOWN id and a
 * JS install to follow, the marker is removed the same way (the install replaces
 * the tree this id says nothing about); no tree is moved.
 *
 * The build log gets generic lines only, never an id, version, path or marker
 * content.
 *
 * PRECONDITION per mode (the tenant-file helpers need no tenant writer):
 *  - docker: none at this point. Build containers are one-shot per command and
 *    have exited, and the runtime /app mount is read-only. RESIDUAL: a build
 *    container orphaned by a platform restart mid-build keeps running and
 *    writing the tree; nothing reaps `drop-build-*` at boot yet (follow-up).
 *    The chmods go through no-follow handles so such a writer cannot steer
 *    them at a host path.
 *  - none: the tenant runs as the platform uid by design, so there is no
 *    escalation to guard against. REVISIT this if PM2 apps ever get their own
 *    uid.
 */
export async function ensureFreshNodeModules(
  context: BuildContext,
  strategyWillChooseJsInstall: boolean
): Promise<DependencySettle> {
  const asideRoot = context.nodeModulesAsideDir;
  const own = asideRoot ? parkedTreePaths(context.appPath, asideRoot) : undefined;
  // Recovery before anything is classified, moved or swept: a parked tree is the
  // only copy of the previous dependencies.
  let swept = true;
  if (asideRoot && own) {
    if ((await restoreParkedTree(context.appPath, asideRoot)) === 'failed') {
      throw new Error('could not restore node_modules parked by an earlier build');
    }
    swept = await sweepAside(asideRoot, own.slot);
  }

  const markerRel = path.join(NODE_MODULES_DIR, TOOLCHAIN_MARKER);
  const willInstall = jsInstallWillRun(context, strategyWillChooseJsInstall);
  const dropMarker = async (): Promise<void> => {
    try {
      await removeTenantPath(context.appPath, markerRel);
    } catch {
      // Best-effort: this only drops a stale claim. If it fails the tree keeps
      // it, which is no worse than before this build.
    }
  };

  const id = context.toolchainId;
  if (!id) {
    if (willInstall) await dropMarker();
    return new ToolchainDeps(context, false, null);
  }

  const state = await checkTree(context.appPath, id);
  if (state === 'refused') return new ToolchainDeps(context, false, null);
  if (state === 'match' || state === 'no-modules') {
    return new ToolchainDeps(context, willInstall, null);
  }

  // stale | unmarked
  if (!willInstall) {
    if (state === 'stale') await dropMarker();
    return new ToolchainDeps(context, false, null);
  }

  context.onBuildLog?.(
    state === 'stale'
      ? 'Dependencies were built for a different Node runtime; reinstalling.'
      : 'Dependencies carry no record of their Node runtime; reinstalling.'
  );
  if (!(await hasLockfile(context.appPath))) {
    context.onBuildLog?.(
      'Warning: no lockfile found, so reinstalled dependency versions may differ from the previous build.'
    );
  }

  let parkedAt: { slot: string; parked: string } | null = null;
  // No aside dir, or EXDEV (it is on another filesystem, so the tree cannot be
  // renamed there): remove the tree in place instead.
  let removeInPlace = !own;
  if (own) {
    // The sweep could not clear an earlier leftover: refuse rather than let a
    // tenant park one more unmeasured tree per deploy.
    if (!swept) throw new Error('could not clear an earlier moved-aside node_modules');
    try {
      await fs.mkdir(own.slot, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new Error('could not move node_modules built for a different Node runtime', {
        cause,
      });
    }
    const result = await moveTenantDirOut(context.appPath, NODE_MODULES_DIR, own.parked);
    if (result.kind === 'moved') {
      parkedAt = own;
    } else if (result.kind === 'failed' && result.code === 'EXDEV') {
      removeInPlace = true;
    } else if (result.kind !== 'absent') {
      // refused, or any other rename failure: the tree is untouched.
      throw new Error('could not move node_modules built for a different Node runtime');
    }
    // `absent`: the tree vanished since checkTree; the install starts from empty.
  }

  if (removeInPlace) {
    context.onBuildLog?.('Dependencies were removed in place; they cannot be restored.');
    try {
      await removeTenantPath(context.appPath, NODE_MODULES_DIR);
    } catch (cause) {
      throw new Error('could not remove node_modules built for a different Node runtime', {
        cause,
      });
    }
  }

  return new ToolchainDeps(context, true, parkedAt);
}

/**
 * Stamp `node_modules` with this build's toolchain id after a successful JS
 * install, when the handle ensureFreshNodeModules returned says (after the hooks,
 * in beforeInstall) that this build installed the tree from empty or found it
 * matching. Never stamps for a custom install, a preset skip, an unknown
 * toolchain, a tree the build did not own, or a handle this module did not make.
 * Best-effort: a refused write (or no node_modules at all, as for a
 * zero-dependency app) just leaves the tree unmarked, which the next build parks
 * and reinstalls rather than treating as a match.
 *
 * PRECONDITION: as ensureFreshNodeModules (docker: the install container has
 * exited before postInstall; none: the tenant runs as the platform uid).
 */
export async function stampToolchain(
  context: BuildContext,
  installCommand: string | null,
  deps: DependencySettle | undefined
): Promise<void> {
  const id = context.toolchainId;
  if (!id || !(deps instanceof ToolchainDeps) || !deps.mayStamp || context.config.skipInstall) {
    return;
  }
  if (installCommand === null || !isJsInstallCommand(installCommand)) return;
  await writeTenantFile(context.appPath, path.join(NODE_MODULES_DIR, TOOLCHAIN_MARKER), id);
}

/**
 * Boot backfill: stamp an existing `node_modules` that has no marker with `id`,
 * the toolchain running it now. Valid only on the first boot of the release that
 * introduced the marker, when every tree on disk was built by the toolchain that
 * is current: nothing has changed it since. Touches only `unmarked` trees, so it
 * never overwrites a stamp and never vouches for a `stale` or `refused` one.
 *
 * PRECONDITION: no tenant process can write the tree during the call (docker:
 * runtime containers mount the tree read-only and no build has started; none: the
 * tenant runs as the platform uid, so there is no boundary to defend).
 */
export async function backfillToolchainMarker(treeRoot: string, id: string): Promise<boolean> {
  if ((await checkTree(treeRoot, id)) !== 'unmarked') return false;
  return writeTenantFile(treeRoot, path.join(NODE_MODULES_DIR, TOOLCHAIN_MARKER), id);
}
