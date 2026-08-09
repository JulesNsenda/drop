/**
 * Git Client
 *
 * Thin wrapper around the git CLI for clone, pull, and metadata operations.
 *
 * `gitPull` reads a PAT from a credential helper's environment (never argv,
 * never `.git/config`) — see the comment on gitPull for why. `gitClone` still
 * injects a PAT directly into the HTTPS URL it is given, which git then
 * records verbatim into the new repo's `.git/config`; that path is untouched
 * by this file's redeploy fix and the header's old blanket claim ("PATs are
 * ... never written to disk") did not hold for it either.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitCloneOptions } from './git-deploy.types';

const execFileAsync = promisify(execFile);

/**
 * Sanitize git output to strip any tokens that might appear in error messages.
 *
 * Now INERT for both clone and pull: neither builds a token-bearing URL any
 * more, so no git error message this wraps can contain one. Kept because the
 * repoUrl a tenant supplies could itself carry userinfo
 * (`https://user:pat@host/...`), which this still strips from surfaced errors
 * — but do NOT read its presence as evidence that DROP's own credential
 * handling depends on scrubbing output. It does not, any more.
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
 * Verified against Git for Windows 2.50.0 as well as POSIX git: Git for
 * Windows bundles its own `sh`, so the `!`-style helper is portable. Exported
 * so the test that proves the helper actually executes uses the SAME string
 * this code passes, rather than a copy that could drift out of sync.
 */
export const CREDENTIAL_HELPER_ARGS: readonly string[] = [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!f(){ echo username=x-access-token; echo "password=$GIT_ASKPASS_TOKEN"; };f',
];

/** Env for a git child that must authenticate, without mutating `process.env`. */
export function credentialEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_ASKPASS_TOKEN: token };
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

/** Pull latest changes in a repository */
export async function gitPull(repoPath: string, branch: string, token?: string): Promise<void> {
  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  try {
    if (token) {
      // Never touch the remote URL with the token — see CREDENTIAL_HELPER_ARGS
      // for the mechanism. The old `git remote set-url origin https://TOKEN@…`
      // wrote the PAT in cleartext into <repoPath>/.git/config: the tenant's
      // document root for a static app, bind-mounted into their container
      // under docker isolation, and left there permanently if the process died
      // before the `finally` restored the clean URL.
      await execFileAsync('git', [...CREDENTIAL_HELPER_ARGS, 'pull', 'origin', branch], {
        cwd: repoPath,
        timeout: 120_000,
        env: credentialEnv(token),
      });
    } else {
      await execFileAsync('git', ['pull', 'origin', branch], { cwd: repoPath, timeout: 120_000 });
    }
  } catch (err) {
    const message = err instanceof Error ? sanitizeOutput(err.message) : 'Pull failed';
    throw new Error(message);
  }
}

/** Get the HEAD commit SHA */
export async function getCommitSha(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

/** Get the current branch name */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}
