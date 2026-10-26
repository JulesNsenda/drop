/**
 * Static Site Build Strategy
 *
 * Handles two flavors of static app:
 *  - Already-built static: the app already ships its output (a `dist`/
 *    `build`/etc directory containing an index.html, or a plain root
 *    `index.html`) — served as-is, no install/build.
 *  - Source SPA: the app root has a `package.json` with a `build` script and
 *    no build output yet (e.g. a plain Vite/CRA/Vue repo dropped as source).
 *    Detected via the same nodejs/static detector confidence tie that
 *    classifies such a repo as `spa`/`static` instead of `nodejs` (see
 *    detector.ts `selectBestResult`). Without this, the app would never
 *    install/build and would be served from its unbuilt source root. Installs
 *    deps, runs the build, then serves the produced output directory.
 */

import * as path from 'path';
import { BuildContext, DependencySettle } from '../builder.types';
import { AppType, PackageJson } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';
import { NODE_MODULES_BUILD_TYPES, NODE_RUNTIME_TYPES } from '../node-types';
import { ensureFreshNodeModules, stampToolchain } from '../toolchain';
import { readTenantText } from '../../../utils/tenant-file';

const STATIC_OUTPUT_DIRS = ['dist', 'build', 'public', 'out', '_site', 'www'];

/**
 * Output dir to assume when a source-SPA build finishes but none of
 * STATIC_OUTPUT_DIRS contains an index.html (should be rare - Vite and CRA
 * both default to `dist`/`build`, both already in that list).
 */
const DEFAULT_BUILD_OUTPUT_DIR = 'dist';

/** package.json is tenant-authored; far bigger than any real one. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export class StaticBuildStrategy extends BaseBuildStrategy {
  name = 'static';
  // The node-modules build types that are not node runtimes: static and spa.
  supportedTypes: AppType[] = NODE_MODULES_BUILD_TYPES.filter(
    (type) => !NODE_RUNTIME_TYPES.includes(type)
  );

  getInstallCommand(context: BuildContext): string | null {
    // Set by preBuild only for the source-SPA path; stays null (no install
    // step) for already-built static sites.
    return context.config.installCommand ?? null;
  }

  getBuildCommand(context: BuildContext): string | null {
    // Set by preBuild only for the source-SPA path; stays null (no build
    // step) for already-built static sites.
    return context.config.buildCommand ?? null;
  }

  getOutputDirectory(context: BuildContext): string | null {
    // Use custom output directory if provided
    if (context.config.outputDirectory) {
      return context.config.outputDirectory;
    }

    // Already-built sites: resolved in preBuild. Source SPAs: resolved in
    // postBuild once the build has actually produced output.
    return '.';
  }

  /**
   * Runs before the drop.yaml preBuild hooks. Asks the same question preBuild
   * acts on (willChooseJsInstall). Only a preset JS install command (which
   * getInstallCommand still returns) runs an install in the other cases. The
   * returned handle is settled by the builder.
   */
  async prepareDependencies(context: BuildContext): Promise<DependencySettle> {
    return ensureFreshNodeModules(context, await this.willChooseJsInstall(context, true));
  }

  async preBuild(context: BuildContext): Promise<void> {
    // Source SPA: package.json declares a `build` script but no build output
    // exists yet. Install + build; the produced output dir is resolved in
    // postBuild, after the build has actually run.
    if (await this.willChooseJsInstall(context)) {
      await this.configureSourceSpaBuild(context);
      return;
    }

    if (context.config.outputDirectory) {
      // Explicit override - nothing to detect.
      return;
    }

    // Already-built: a known build-output directory already contains an
    // index.html (e.g. a committed `dist/`, or output left over from a
    // previous build). Serve it as-is - do not install/rebuild.
    const existingOutputDir = await this.findOutputDirWithIndex(context.appPath);
    if (existingOutputDir) {
      context.config.outputDirectory = existingOutputDir;
      return;
    }

    // Plain static site served straight from the repo root.
    const rootIndex = path.join(context.appPath, 'index.html');
    if (await this.fileExists(rootIndex)) {
      context.config.outputDirectory = '.';
    }
  }

  /** Stamp node_modules after a successful JS install (source SPA or preset command). */
  async postInstall(context: BuildContext, deps?: DependencySettle): Promise<void> {
    try {
      await stampToolchain(context, this.getInstallCommand(context), deps);
    } catch {
      // Best-effort: an unstamped tree is left for the next install to reconcile.
    }
  }

  async postBuild(context: BuildContext, _outputPath: string): Promise<void> {
    // Only the source-SPA path (above) leaves outputDirectory unset at this
    // point - already-built and plain-root static sites resolved it in
    // preBuild and must be left untouched here.
    if (context.config.outputDirectory) {
      return;
    }

    const builtDir = await this.findOutputDirWithIndex(context.appPath);
    context.config.outputDirectory = builtDir ?? DEFAULT_BUILD_OUTPUT_DIR;
  }

  async validate(context: BuildContext, _outputPath: string): Promise<boolean> {
    const outputDir = context.config.outputDirectory || '.';
    const indexPath = path.join(context.appPath, outputDir, 'index.html');
    return this.fileExists(indexPath);
  }

  /**
   * True when this strategy will pick a JS install for itself: no explicit
   * outputDirectory, no existing output dir with an index (already-built), and a
   * package.json with a `build` script (a source SPA). The ONE answer
   * prepareDependencies and preBuild both act on. `announce` is true for the
   * first asker only (prepareDependencies), so a refused package.json is logged
   * once per build, not once per asker.
   */
  private async willChooseJsInstall(context: BuildContext, announce = false): Promise<boolean> {
    return (
      !context.config.outputDirectory &&
      !(await this.findOutputDirWithIndex(context.appPath)) &&
      (await this.isSourceSpa(context.appPath, announce ? context.onBuildLog : undefined))
    );
  }

  /**
   * First entry of STATIC_OUTPUT_DIRS (in priority order) that contains an
   * index.html, or null if none do.
   */
  private async findOutputDirWithIndex(appPath: string): Promise<string | null> {
    for (const dir of STATIC_OUTPUT_DIRS) {
      const indexPath = path.join(appPath, dir, 'index.html');
      if (await this.fileExists(indexPath)) {
        return dir;
      }
    }
    return null;
  }

  /**
   * True when appPath has a package.json declaring a `build` script - i.e.
   * it's a buildable source SPA rather than a plain static site.
   */
  private async isSourceSpa(appPath: string, onLog?: (line: string) => void): Promise<boolean> {
    // Hardened read: package.json can be a symlink or FIFO a tenant left
    // behind. Absent or refused is "not a source SPA", as a read error was; a
    // refusal is logged (generic, no path), since the app is then served
    // unbuilt rather than installed and built.
    const read = await readTenantText(appPath, 'package.json', MAX_PACKAGE_JSON_BYTES);
    if (read.kind === 'refused') {
      onLog?.('package.json is not a plain file; treating the app as already built.');
    }
    if (read.kind !== 'ok') return false;
    try {
      const pkg = JSON.parse(read.text) as PackageJson;
      return Boolean(pkg.scripts?.build);
    } catch {
      // Not valid JSON: not a buildable source SPA.
      return false;
    }
  }

  /**
   * Populate installCommand/buildCommand for a source SPA, mirroring the
   * Node.js strategy's lockfile-based package-manager selection
   * (nodejs.ts preBuild).
   */
  private async configureSourceSpaBuild(context: BuildContext): Promise<void> {
    const packageManager = await this.detectPackageManager(context.appPath);

    if (!context.config.installCommand) {
      switch (packageManager) {
        case 'pnpm':
          context.config.installCommand = 'pnpm install --frozen-lockfile';
          break;
        case 'yarn':
          context.config.installCommand = 'yarn install --frozen-lockfile';
          break;
        default: {
          const hasLockfile = await this.fileExists(
            path.join(context.appPath, 'package-lock.json')
          );
          context.config.installCommand = hasLockfile ? 'npm ci' : 'npm install';
        }
      }
    }

    if (!context.config.buildCommand) {
      switch (packageManager) {
        case 'pnpm':
          context.config.buildCommand = 'pnpm run build';
          break;
        case 'yarn':
          context.config.buildCommand = 'yarn build';
          break;
        default:
          context.config.buildCommand = 'npm run build';
      }
    }
  }
}

export const staticBuildStrategy = new StaticBuildStrategy();
