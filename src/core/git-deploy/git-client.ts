/**
 * Git Client
 *
 * Thin wrapper around the git CLI for clone, pull, and metadata operations.
 * PATs are injected in-memory into HTTPS URLs and never written to disk or logs.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitCloneOptions } from './git-deploy.types';

const execFileAsync = promisify(execFile);

/** Sanitize git output to strip any tokens that might appear in error messages */
function sanitizeOutput(output: string): string {
  // Strip tokens from https://TOKEN@github.com URLs
  return output.replace(/https:\/\/[^@]+@/g, 'https://***@');
}

/** Inject a PAT into a GitHub HTTPS URL */
function injectToken(url: string, token: string): string {
  return url.replace('https://github.com/', `https://${token}@github.com/`);
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

/** Check if git CLI is available */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** Clone a repository */
export async function gitClone(options: GitCloneOptions): Promise<void> {
  const { url, dest, branch, token, shallow = true } = options;

  const cloneUrl = token ? injectToken(url, token) : url;
  const args = ['clone'];

  if (shallow) {
    args.push('--depth', '1');
  }

  args.push('--branch', branch, cloneUrl, dest);

  try {
    await execFileAsync('git', args, { timeout: 120_000 });
  } catch (err) {
    const message = err instanceof Error ? sanitizeOutput(err.message) : 'Clone failed';
    throw new Error(message);
  }
}

/** Pull latest changes in a repository */
export async function gitPull(repoPath: string, branch: string, token?: string): Promise<void> {
  try {
    // If token provided, set the remote URL temporarily
    if (token) {
      const { stdout: remoteUrl } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
      const authedUrl = injectToken(remoteUrl.trim(), token);
      await execFileAsync('git', ['remote', 'set-url', 'origin', authedUrl], { cwd: repoPath });

      try {
        await execFileAsync('git', ['pull', 'origin', branch], { cwd: repoPath, timeout: 120_000 });
      } finally {
        // Restore original URL (without token)
        await execFileAsync('git', ['remote', 'set-url', 'origin', remoteUrl.trim()], { cwd: repoPath });
      }
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
