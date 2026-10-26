/**
 * Git Client
 *
 * Thin wrapper around the git CLI. It clones into a platform-owned temporary
 * directory and reads the commit SHA and the tracked-file list from that clone;
 * it NEVER runs git inside an app's own folder, because under docker isolation
 * that folder is bind-mounted into tenant containers and everything in it
 * (`.git/config`, hooks) is tenant-writable. `runGit` refuses any working
 * directory outside the configured clone base. The deploy service then copies
 * the tracked files into the app folder without any `.git` (see `land.ts`).
 *
 * `gitClone` reads a PAT from a credential helper's environment — never argv,
 * never the remote URL, never `.git/config`. See `CREDENTIAL_HELPER_ARGS`.
 *
 * Every git child goes through `runGit`, the module's only process spawn.
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
 * 1. A recorded `gitSource.repoUrl` from an older install can still carry
 *    userinfo (`https://TOKEN@github.com/...`), and a failed clone prints the
 *    URL it was given, PAT included. That text would otherwise reach an HTTP
 *    500 body and the deploy-details store. (The redeploy path also strips the
 *    userinfo before cloning; this is the net under it.)
 * 2. A repoUrl a tenant supplies can itself carry userinfo.
 *
 * What it is NOT is the mechanism protecting DROP's own credential handling:
 * the clone never builds a token-bearing URL. It is a net, not the design.
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
 * answers for EVERY host git asks about, including the new host after an HTTP
 * redirect, where git re-resolves credentials. Unscoped, a redirecting remote
 * would be handed the PAT in cleartext. `isValidGitHubUrl` admits only
 * github.com repos, so the scope costs nothing.
 *
 * **Order matters.** The empty reset comes FIRST and the scoped helper after
 * it; a `credential.helper=` placed after the scoped helper would wipe it and
 * break every private-repo clone, so `buildCloneArgs` appends these LAST among
 * the `-c` options.
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

/**
 * A recorded repository URL with the userinfo removed, or `null` if there was
 * none to remove (or it isn't a URL at all). Older installs may have stored a
 * credentialed URL; the redeploy path strips it before validating.
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
 * Hardening every git child carries. The directory git runs in is a fresh
 * clone DROP made itself, so there is no tenant config to defend against; this
 * is belt and braces for the repository's own content.
 *
 * `protocol.allow=never` + `protocol.https.allow=always`: the only transport
 * is https. A test-only option opts a single extra protocol in
 * (`allowFileProtocol`), so the production default is never weakened to suit
 * the suite.
 *
 * The `filter.lfs.*` overrides (with `GIT_LFS_SKIP_SMUDGE` in the env) keep
 * a Git LFS filter installed on the host from downloading during checkout.
 */
function hardeningArgs(allowFileProtocol: boolean): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    ...(allowFileProtocol ? ['-c', 'protocol.file.allow=always'] : []),
    '-c',
    'filter.lfs.process=',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.required=false',
  ];
}

/**
 * Variables that redirect git to other files or make it run a program. Only
 * these are dropped from the inherited environment: `GIT_SSL_*`,
 * `GIT_HTTP_*`, `GIT_CURL_VERBOSE` and `GIT_TRACE*` are how an operator
 * configures TLS, proxies and diagnostics, and stay.
 */
const REDIRECTING_GIT_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'GIT_CEILING_DIRECTORIES',
  'GIT_TEMPLATE_DIR',
  'GIT_ALLOW_PROTOCOL',
  'GIT_PROXY_COMMAND',
]);

function isRedirectingGitEnv(key: string): boolean {
  const k = key.toUpperCase();
  return REDIRECTING_GIT_ENV.has(k) || k.startsWith('GIT_CONFIG') || k.startsWith('GIT_SSH');
}

/**
 * The environment for a git child: this process's, minus the redirecting or
 * program-running `GIT_*` keys, plus what DROP sets itself.
 */
function gitChildEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isRedirectingGitEnv(k)) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  if (token) env.GIT_ASKPASS_TOKEN = token;
  return env;
}

/**
 * The one directory git may run in or write to: the platform-owned clone base
 * (`data/temp/.git-clones`). Set once by the deploy service.
 */
let cloneBase: string | null = null;

export function configureCloneBase(base: string): void {
  cloneBase = path.resolve(base);
}

/** True when `p` is strictly inside the configured clone base. */
function insideCloneBase(p: string): boolean {
  if (!cloneBase) return false;
  const rel = path.relative(cloneBase, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface RunGitOptions {
  args: string[];
  cwd?: string;
  token?: string;
  timeoutMs?: number;
}

/**
 * The ONLY place this module spawns git. A source-scan test pins that, so a
 * future call cannot bypass the environment scrubbing above. It also refuses
 * to run in, or point `--git-dir` at, anything outside the clone base: git is
 * never to touch an app folder.
 */
async function runGit(options: RunGitOptions): Promise<{ stdout: string; stderr: string }> {
  const { args, cwd, token, timeoutMs = 120_000 } = options;
  if (cwd !== undefined && !insideCloneBase(cwd)) {
    throw new Error('Refusing to run git outside the clone directory');
  }
  const gitDirAt = args.indexOf('--git-dir');
  if (gitDirAt >= 0 && !insideCloneBase(args[gitDirAt + 1] ?? '')) {
    throw new Error('Refusing to run git outside the clone directory');
  }
  return execFileAsync('git', args, {
    ...(cwd ? { cwd } : {}),
    timeout: timeoutMs,
    env: gitChildEnv(token),
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Check if git CLI is available */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit({ args: ['--version'], timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The argv `gitClone` hands to git.
 *
 * Separated out and exported so the security properties can be asserted
 * DIRECTLY: the token never appears in argv or in the URL, and the credential
 * helper args come AFTER every reset (a later `credential.helper=` would wipe
 * the helper again and break every private-repo clone).
 */
export function buildCloneArgs(options: GitCloneOptions): string[] {
  const { url, dest, branch, token, allowFileProtocol = false } = options;
  // `--` separates options from positional args so a crafted branch/url
  // can't be reinterpreted as a git flag.
  return [
    ...hardeningArgs(allowFileProtocol),
    ...(token ? CREDENTIAL_HELPER_ARGS : []),
    'clone',
    '--depth',
    '1',
    '--branch',
    branch,
    '--single-branch',
    '--no-recurse-submodules',
    '--',
    url,
    dest,
  ];
}

/** What a finished clone reports. Paths are repository-relative, `/`-separated. */
export interface CloneInfo {
  commitSha?: string;
  /** Tracked regular files (mode 100644/100755). */
  files: string[];
  /** Tracked symbolic links (mode 120000): not recreated in the app folder. */
  symlinks: string[];
}

/**
 * A clone failure without the clone's own text: exit code plus sanitised stderr
 * only. `err.message` would carry the whole argv (URL, absolute temp path).
 */
function cloneFailure(err: unknown, dest: string): Error {
  const e = err as { stderr?: unknown; code?: unknown; killed?: boolean };
  const raw = typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString() : '';
  let text = sanitizeOutput(raw).split(dest).join('<clone>');
  if (cloneBase) text = text.split(cloneBase).join('<temp>');
  text = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  const code = typeof e.code === 'number' ? ` (exit ${e.code})` : '';
  return new Error(`git clone failed${code}${e.killed ? ' (timed out)' : ''}${text ? `: ${text}` : ''}`);
}

/**
 * Shallow-clone one branch into `dest` — an empty directory inside the clone
 * base — and report the commit and what the repository tracks.
 */
export async function gitClone(options: GitCloneOptions): Promise<CloneInfo> {
  const { url, dest, branch, token, allowFileProtocol } = options;

  if (!isValidBranchName(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  if (!insideCloneBase(dest)) {
    throw new Error('Refusing to clone outside the clone directory');
  }

  try {
    await runGit({ args: buildCloneArgs({ url, dest, branch, token, allowFileProtocol }), token });
  } catch (err) {
    throw cloneFailure(err, dest);
  }

  let commitSha: string | undefined;
  try {
    commitSha = await readHead(dest);
  } catch {
    // non-fatal
  }
  const { files, symlinks } = await listTracked(dest);
  return { commitSha, files, symlinks };
}

/**
 * HEAD of a clone DROP made itself. Pinned with `--git-dir` so a missing
 * `.git` fails instead of walking up to an ancestor repository.
 */
async function readHead(clonePath: string): Promise<string> {
  const { stdout } = await runGit({
    args: ['--git-dir', path.join(clonePath, '.git'), ...hardeningArgs(false), 'rev-parse', 'HEAD'],
    cwd: clonePath,
    timeoutMs: 15_000,
  });
  return stdout.trim();
}

/**
 * What the clone's index tracks, split into regular files and symlinks.
 * `ls-files -s -z` entries look like `<mode> <sha> <stage>\t<path>`; gitlinks
 * (submodules, mode 160000) are neither and are dropped.
 */
async function listTracked(clonePath: string): Promise<{ files: string[]; symlinks: string[] }> {
  const { stdout } = await runGit({
    args: ['--git-dir', path.join(clonePath, '.git'), ...hardeningArgs(false), 'ls-files', '-s', '-z'],
    cwd: clonePath,
    timeoutMs: 60_000,
  });
  const files: string[] = [];
  const symlinks: string[] = [];
  for (const entry of String(stdout).split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, entry.indexOf(' '));
    const rel = entry.slice(tab + 1);
    if (mode === '120000') symlinks.push(rel);
    else if (mode === '100644' || mode === '100755') files.push(rel);
  }
  return { files, symlinks };
}
