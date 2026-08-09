/**
 * Git Client
 *
 * Thin wrapper around the git CLI for clone, pull, and metadata operations.
 *
 * BOTH `gitClone` and `gitPull` read a PAT from a credential helper's
 * environment — never argv, never the remote URL, never `.git/config`. See
 * `CREDENTIAL_HELPER_ARGS` for the mechanism and `stripRemoteUrlCredentials`
 * for the cleanup of repositories cloned before that was true.
 *
 * The header used to claim PATs were "never written to disk" while the clone
 * path was in fact recording them permanently in the tenant's own
 * `.git/config`. Do not restore a blanket claim here — state which paths, and
 * keep it true.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { GitCloneOptions } from './git-deploy.types';

const execFileAsync = promisify(execFile);

/**
 * Sanitize git output to strip any tokens that might appear in error messages.
 *
 * STILL LOAD-BEARING, for two cases — do not delete it as dead code:
 *
 * 1. Every app cloned before the URL-injection removal still has
 *    `remote.origin.url = https://TOKEN@github.com/...` on disk until its
 *    first redeploy self-heals it (`stripRemoteUrlCredentials`). A failed
 *    `git pull` against one of those prints the remote URL, PAT included, and
 *    that message reaches an HTTP 500 body and the deploy-details store.
 * 2. A repoUrl a tenant supplies can itself carry userinfo.
 *
 * What it is NOT any more is the mechanism protecting DROP's own credential
 * handling: neither clone nor pull builds a token-bearing URL. It is a net
 * under the installed base, not the design.
 */
function sanitizeOutput(output: string): string {
  // Strip tokens from https://TOKEN@github.com URLs
  return output.replace(/https:\/\/[^@]+@/g, 'https://***@');
}

/** Normalize a GitHub URL: strip trailing .git, ensure https */
export function normalizeRepoUrl(url: string): string {
  let normalized = url.trim();
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }
  // Convert SSH to HTTPS
  if (normalized.startsWith('git@github.com:')) {
    normalized = normalized.replace('git@github.com:', 'https://github.com/');
  }
  return normalized;
}

/** Extract repo name from a GitHub URL */
export function extractRepoName(url: string): string {
  const normalized = normalizeRepoUrl(url);
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

/** Validate that a URL is a valid GitHub repo URL */
export function isValidGitHubUrl(url: string): boolean {
  const normalized = normalizeRepoUrl(url);
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(normalized);
}

/**
 * Validate a git branch/ref name before passing it to the git CLI.
 *
 * Even with execFile (no shell), git interprets a leading '-' as an option,
 * so a value like `--upload-pack=...` would be treated as a flag. We require
 * a conservative charset and forbid leading dashes; callers also pass `--`
 * before positional args as defense in depth.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (branch.startsWith('-')) return false;
  if (branch.includes('..') || branch.includes('@{')) return false;
  if (/[\s~^:?*[\\]/.test(branch)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

/**
 * The `-c` arguments that hand git a PAT without it ever reaching disk or argv.
 *
 * A one-shot credential helper reads the token from the child process's OWN
 * environment (`GIT_ASKPASS_TOKEN`, set via execFile's `env` option) — never
 * argv, which is world-readable via `ps`, and never the remote URL, which git
 * persists into `.git/config`. The first, empty `credential.helper=` resets any
 * system-configured helper so this is the only one git consults. Git runs the
 * `!`-prefixed value through a shell of its own, so the embedded `;`/`{}` need
 * no escaping — this array is passed to execFile with no shell on our side.
 *
 * **Scoped to `https://github.com`, deliberately.** A bare `credential.helper`
 * answers for EVERY host git asks about, and `gitPull` runs against whatever
 * `remote.origin.url` says on disk — a value a tenant who can write their own
 * `.git/config` controls. Unscoped, pointing that at an attacker-controlled
 * host and triggering a redeploy POSTs the PAT to them in cleartext; the same
 * applies to an HTTP redirect, where git re-resolves credentials for the new
 * host. The URL-injection this replaced was host-pinned by construction (it
 * only rewrote a literal `https://github.com/` prefix), so an unscoped helper
 * would have been a real regression. `isValidGitHubUrl` admits only
 * github.com repos, so the scope costs nothing.
 *
 * Verified against Git for Windows 2.50.0 as well as POSIX git: Git for
 * Windows bundles its own `sh`, so the `!`-style helper is portable. Measured
 * both halves of the scoping — `credential fill` for `host=github.com` returns
 * the token, for `host=evil.example.com` returns an empty password. `echo`
 * rather than `printf '%s\n'`: the latter's `\n` is mangled to `/n` by MSYS
 * argument conversion on Windows, which silently emits ONE malformed line.
 * Exported so the test that proves the helper actually executes uses the SAME
 * string this code passes, rather than a copy that could drift out of sync.
 */
export const CREDENTIAL_HELPER_ARGS: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.https://github.com.helper=!f(){ echo username=x-access-token; echo "password=$GIT_ASKPASS_TOKEN"; };f',
];

/** Env for a git child that must authenticate, without mutating `process.env`. */
export function credentialEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_ASKPASS_TOKEN: token };
}

/**
 * A remote URL with the userinfo removed, or `null` if there was none to
 * remove (or it isn't a URL at all).
 *
 * Split out and exported so the rewrite decision is testable without a real
 * repository — the `null` case is what stops a pointless `set-url` on every
 * single pull.
 */
export function stripUrlCredentials(remoteUrl: string): string | null {
  try {
    const u = new URL(remoteUrl.trim());
    if (!u.username && !u.password) return null;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Remove a PAT that an EARLIER version of this code baked into a repository's
 * `remote.origin.url`, before pulling from it.
 *
 * Closing the leak in `gitClone`/`gitPull` does nothing for the installed
 * base: `git clone https://TOKEN@github.com/...` recorded that URL verbatim,
 * so every app cloned before this shipped still holds its PAT in cleartext
 * inside its own directory — which is the bind-mounted container root under
 * docker isolation, and the served document root for a plain static app. Worse
 * for the fix itself: git PREFERS credentials embedded in the remote URL, so
 * on exactly those apps the new credential helper would never fire and the
 * change would be a silent no-op where it matters most.
 *
 * Self-healing on the next redeploy rather than a migration script: the
 * offending value is per-repository and only reachable when we are already
 * running git in that directory. Best-effort — a repo we cannot rewrite must
 * still be pullable, so a failure here is not fatal.
 */
export async function stripRemoteUrlCredentials(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...repoArgs(repoPath), 'remote', 'get-url', 'origin'],
      { cwd: repoPath, timeout: 15_000 }
    );
    const cleaned = stripUrlCredentials(stdout);
    if (!cleaned) return false;
    await execFileAsync(
      'git',
      [...repoArgs(repoPath), 'remote', 'set-url', 'origin', '--', cleaned],
      { cwd: repoPath, timeout: 15_000 }
    );
    return true;
  } catch {
    return false;
  }
}

/** Check if git CLI is available */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The argv `gitClone` hands to git.
 *
 * Separated out and exported so the security property can be asserted
 * DIRECTLY rather than inferred from a clone against a local remote — which
 * needs no credentials, so it exercises none of this and would pass either
 * way. The property: the token never appears in argv or in the URL.
 *
 * It used to. `git clone https://TOKEN@host/...` records that URL verbatim as
 * `remote.origin.url` in the new repo's `.git/config`, so every private-repo
 * app carried its PAT in cleartext inside its own directory — the served
 * document root for a static app, bind-mounted into the tenant's container
 * under docker isolation — PERMANENTLY. The pull path had the same leak only
 * for the duration of the pull; this one outlived the deploy.
 */
export function buildCloneArgs(options: GitCloneOptions): string[] {
  const { url, dest, branch, token, shallow = true } = options;
  const args = [...(token ? CREDENTIAL_HELPER_ARGS : []), 'clone'];

  if (shallow) {
    args.push('--depth', '1');
  }

  // `--` separates options from positional args so a crafted branch/url
  // can't be reinterpreted as a git flag.
  args.push('--branch', branch, '--', url, dest);
  return args;
}

/** Clone a repository */
export async function gitClone(options: GitCloneOptions): Promise<void> {
  const { url, dest, branch, token, shallow = true } = options;

  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  const args = buildCloneArgs({ url, dest, branch, token, shallow });

  try {
    await execFileAsync('git', args, {
      timeout: 120_000,
      ...(token ? { env: credentialEnv(token) } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? sanitizeOutput(err.message) : 'Clone failed';
    throw new Error(message);
  }
}

/**
 * Pin git to EXACTLY this app's repository.
 *
 * With only `cwd`, git discovers a repository by walking UP the ancestor
 * chain, so an app directory whose `.git` has gone missing — an upload deploy
 * or a monorepo re-materialization racing a redeploy — resolves to whatever
 * repository exists above it. Measured: `rev-parse HEAD` in a non-repo
 * subdirectory returned the ANCESTOR's SHA and exited 0, which would then be
 * persisted as the app's `lastCommitSha`. With `--git-dir` git refuses:
 * `fatal: not a git repository`.
 *
 * A caller-side `fs.access('.git')` check cannot give this — it is a
 * precondition one call site remembers, not an invariant every call inherits
 * (CLAUDE.md: "security helpers have callers"). `--work-tree` is included for
 * the commands that touch files; measured that `pull` fast-forwards the
 * working tree correctly through it.
 */
function repoArgs(repoPath: string, withWorkTree = false): string[] {
  const args = ['--git-dir', path.join(repoPath, '.git')];
  if (withWorkTree) args.push('--work-tree', repoPath);
  return args;
}

/** Pull latest changes in a repository */
export async function gitPull(repoPath: string, branch: string, token?: string): Promise<void> {
  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  // Before anything else, evict a PAT an older DROP baked into this repo's
  // remote URL. Unconditional — a repo can carry the leftover credential even
  // when this pull supplies no token — and it must run BEFORE the pull, since
  // git prefers a URL-embedded credential over any helper.
  await stripRemoteUrlCredentials(repoPath);
  const pullArgs = [...repoArgs(repoPath, true), 'pull', 'origin', branch];
  try {
    if (token) {
      // Never touch the remote URL with the token — see CREDENTIAL_HELPER_ARGS
      // for the mechanism. The old `git remote set-url origin https://TOKEN@…`
      // wrote the PAT in cleartext into <repoPath>/.git/config: the tenant's
      // document root for a static app, bind-mounted into their container
      // under docker isolation, and left there permanently if the process died
      // before the `finally` restored the clean URL.
      await execFileAsync('git', [...CREDENTIAL_HELPER_ARGS, ...pullArgs], {
        cwd: repoPath,
        timeout: 120_000,
        env: credentialEnv(token),
      });
    } else {
      await execFileAsync('git', pullArgs, { cwd: repoPath, timeout: 120_000 });
    }
  } catch (err) {
    const message = err instanceof Error ? sanitizeOutput(err.message) : 'Pull failed';
    throw new Error(message);
  }
}

/** Get the HEAD commit SHA */
export async function getCommitSha(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...repoArgs(repoPath), 'rev-parse', 'HEAD'], {
    cwd: repoPath,
  });
  return stdout.trim();
}

/** Get the current branch name */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [...repoArgs(repoPath), 'rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repoPath }
  );
  return stdout.trim();
}
