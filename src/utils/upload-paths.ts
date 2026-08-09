/**
 * Pure path helpers shared by the dashboard's browser-side archive builder
 * and (for `isVcsMetadataComponent`) the server's tar extractor (DROP-141).
 *
 * `Uint8Array`/plain strings only — zero DOM types, zero `node:*` imports, so
 * this file can be pulled straight into the dashboard's Vite bundle. The
 * root tsconfig compiles this file (and ts-jest compiles it per-file for its
 * test) against `lib: ["ES2022"]` with no `dom` lib.
 */

/**
 * True if `component` (one `/`- or `\`-separated segment of an entry path)
 * names `.git`, case-insensitively, once the Windows aliases below are
 * normalized away. Exported so the same policy can be applied to
 * caller-supplied paths before they ever reach `tar-extract.ts` (see
 * `validateStagedRelativePath` in `src/api/mcp/tools.ts`) and, since
 * DROP-141, before the dashboard ever builds an archive containing `.git` —
 * rather than being duplicated inline. Lives here rather than in
 * `tar-extract.ts` because that module pulls in `node:fs`, `node:zlib`,
 * `node:path` and node-tar; importing it from the dashboard would drag all
 * of that into the browser bundle.
 *
 * Covers three ways a component can name `.git` without spelling it exactly:
 *  - case (`.GIT`/`.Git` name the same directory on a case-insensitive
 *    filesystem);
 *  - a trailing run of dots/spaces, which Win32 strips during path
 *    normalization, so `.git.` and `.git ` both materialize as `.git` when
 *    mkdir runs on a Windows host (DROP_ROOT is C:\drop there);
 *  - an NTFS alternate data stream suffix (`.git::$INDEX_ALLOCATION`,
 *    `.git::$DATA`) — the part before `::` is the real filesystem name the
 *    stream hangs off, so it's stripped before the rest of the comparison;
 *  - an 8.3 short name (`GIT~1`) — Windows generates these automatically for
 *    long/mixed-case names, and resolving the alias reaches the same `.git`
 *    directory, so `lstat`/`copyInto` in `syncTree` would follow it straight
 *    through.
 *
 * These are Windows-host normalizations specifically (checked against how
 * NTFS and Win32 path handling resolve a name to a directory) — this does not
 * claim to catch every OS-specific path alias, only the ones a Windows
 * DROP_ROOT is known to apply.
 */
export function isVcsMetadataComponent(component: string): boolean {
  const c = component.toLowerCase().split('::')[0].replace(/[. ]+$/, '');
  return c === '.git' || /^git~\d+$/.test(c);
}

/**
 * Valid app name, mirroring the SERVER's real creation rule
 * (`APP_NAME_RE` in `src/api/middleware/validate.ts:11`,
 * `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`) — NOT the looser `/^[\w.-]+$/` used
 * for git-deployed app names in `src/core/git-deploy/git-deploy.ts:90`. A
 * dotted name (e.g. `my.app`) passes that looser rule but fails here, and
 * would also miss the request body-size carve-out `UPLOAD_SOURCE_PATH_RE`
 * (`src/api/server.ts:55`), which matches `[A-Za-z0-9_-]+` only — so a
 * dotted name sent to `/apps/:name/source` fails confusingly with "Request
 * body too large" rather than a clear validation error.
 */
export const APP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Thrown by `normalizeEntryPath` when a path cannot be represented safely. */
export class PathNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNormalizationError';
  }
}

/**
 * Normalizes a single archive entry path: strips a leading `/`, strips `./`
 * segments, collapses repeated `/`, and strips a trailing `/`. Load-bearing,
 * not cosmetic — node-tar does none of this itself:
 *  - a leading `/` would resolve outside the server's destination directory
 *    (`path_escape`), taking the whole archive down with it;
 *  - `./index.html` and `index.html` would otherwise resolve to two
 *    different-looking entries that collide on write (`path_collision`);
 *  - a trailing `/` on a typeflag-`0` entry makes node-tar retype it as a
 *    Directory and discard its body, so the archive fails as `empty_archive`
 *    despite holding real data.
 *
 * Throws on any `..` segment (path traversal) and on any `\` — on Windows
 * `path.resolve` treats `a\b.txt` as a nested path, but on the Linux
 * production box it is one legal filename, so the same archive would build a
 * different tree in dev than in prod.
 */
export function normalizeEntryPath(p: string): string {
  if (p.includes('\\')) {
    throw new PathNormalizationError(`Path contains a backslash, which is not portable across platforms: ${p}`);
  }

  let stripped = p;
  while (stripped.startsWith('/')) stripped = stripped.slice(1);
  stripped = stripped.replace(/\/{2,}/g, '/');

  const segments = stripped.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new PathNormalizationError(`Path escapes its base directory: ${p}`);
  }

  return segments.join('/');
}

/**
 * Removes a single shared leading directory from every path — the wrapping
 * folder name a `webkitdirectory` selection prefixes onto every entry, which
 * `/:name/source` does not strip server-side (no strip-components: entry
 * paths must already be relative to the app root).
 *
 * The shared root must be a full path SEGMENT, not merely a common string
 * prefix: `app1/x` and `app10/y` share no root even though their names share
 * the characters `app1`, because the first segments (`app1` vs `app10`)
 * differ. A single top-level file with no `/` at all (e.g. a lone
 * `index.html`) also means there is no shared directory to strip.
 *
 * Expects every path to have already been through `normalizeEntryPath` —
 * an un-normalized `app/` (trailing slash) would compare unequal to `app`
 * and be treated as "no shared root".
 */
export function stripCommonRoot(paths: string[]): string[] {
  const root = commonRootName(paths);
  if (root === null) return paths;
  return paths.map((p) => p.slice(root.length + 1));
}

/**
 * The single shared leading directory `stripCommonRoot` would remove, or
 * `null` when there isn't one.
 *
 * Exists because the dashboard needs the root's NAME, not the stripped paths:
 * a folder upload derives the app name from it, and that has to happen before
 * the pre-flight `GET /apps/:name` — which in turn runs before the archive is
 * built, so the user isn't made to wait through a tar+gzip only to be told the
 * target is git-backed. Sharing the segment logic with `stripCommonRoot` keeps
 * the name the client derives and the root the server-bound paths lose from
 * ever disagreeing.
 *
 * Same contract as `stripCommonRoot`: expects paths already through
 * `normalizeEntryPath`.
 */
export function commonRootName(paths: string[]): string | null {
  if (paths.length === 0) return null;

  const firstSegments = paths.map((p) => {
    const idx = p.indexOf('/');
    return idx === -1 ? null : p.slice(0, idx);
  });

  const root = firstSegments[0];
  if (root === null) return null;
  if (!firstSegments.every((segment) => segment === root)) return null;

  return root;
}

/**
 * Finds pairs of paths that would collide once written to disk, using the
 * server's own collision key shape — `normalize('NFC').toLowerCase()`
 * (`tar-extract.ts:226`) — so the client can name the offending pair up
 * front instead of the server aborting the whole upload with a single
 * unattributed `path_collision`. Safari's `webkitRelativePath` yields NFD on
 * macOS, and a Linux-authored repo may legitimately hold both `README.md`
 * and `readme.md`.
 *
 * Expects every path to have already been through `normalizeEntryPath` —
 * the server's own key is computed from `path.resolve`'s output, which
 * collapses `./`/`//` first, so e.g. `./a.txt` and `a.txt` collide server-side
 * even though they'd compare unequal here without that step.
 */
export function findCollisions(paths: string[]): [string, string][] {
  const seen = new Map<string, string>();
  const collisions: [string, string][] = [];

  for (const p of paths) {
    const key = p.normalize('NFC').toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      collisions.push([first, p]);
    } else {
      seen.set(key, p);
    }
  }

  return collisions;
}

/** Directory/file names excluded by default when building an archive from a
 * folder selection, shown to the user as the "skipped" list. `.git` is
 * matched via `isVcsMetadataComponent` (case/alias-aware — see its own doc
 * comment); `node_modules` is a plain, case-sensitive component match. This
 * is now correctness, not just hygiene: `.git` is refused outright by the
 * server after DROP-144 (`reason: 'vcs_metadata'`), so without stripping it
 * client-side, every folder drop from a checked-out repo 400s; a typical
 * `node_modules` alone can exceed the 20 000-entry archive cap. */
export const DEFAULT_EXCLUDES: readonly string[] = ['node_modules'];

/** True if `entryPath` (forward-slash-separated) has a component that is
 * `.git` or an exact match in `DEFAULT_EXCLUDES`. */
export function isExcludedByDefault(entryPath: string): boolean {
  return entryPath
    .split('/')
    .some((component) => isVcsMetadataComponent(component) || DEFAULT_EXCLUDES.includes(component));
}
