/**
 * Git Client Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isValidBranchName,
  gitPull,
  gitClone,
  buildCloneArgs,
  CREDENTIAL_HELPER_ARGS,
  credentialEnv,
} from './git-client';

const run = promisify(execFile);

/** Like execFile, but writes `input` to the child's stdin — needed for `git credential fill`. */
function runWithStdin(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { env }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout: stdout.toString(), stderr: stderr.toString() }));
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
    child.stdin?.end(input);
  });
}

describe('Git Client', () => {
  describe('normalizeRepoUrl', () => {
    it('should strip trailing .git', () => {
      expect(normalizeRepoUrl('https://github.com/user/repo.git')).toBe(
        'https://github.com/user/repo'
      );
    });

    it('should leave clean URLs unchanged', () => {
      expect(normalizeRepoUrl('https://github.com/user/repo')).toBe(
        'https://github.com/user/repo'
      );
    });

    it('should trim whitespace', () => {
      expect(normalizeRepoUrl('  https://github.com/user/repo  ')).toBe(
        'https://github.com/user/repo'
      );
    });

    it('should convert SSH URLs to HTTPS', () => {
      expect(normalizeRepoUrl('git@github.com:user/repo.git')).toBe(
        'https://github.com/user/repo'
      );
    });

    it('should handle SSH URLs without .git suffix', () => {
      expect(normalizeRepoUrl('git@github.com:user/repo')).toBe(
        'https://github.com/user/repo'
      );
    });
  });

  describe('extractRepoName', () => {
    it('should extract repo name from HTTPS URL', () => {
      expect(extractRepoName('https://github.com/user/my-app')).toBe('my-app');
    });

    it('should strip .git suffix', () => {
      expect(extractRepoName('https://github.com/user/my-app.git')).toBe('my-app');
    });

    it('should extract from SSH URL', () => {
      expect(extractRepoName('git@github.com:user/my-app.git')).toBe('my-app');
    });
  });

  describe('isValidGitHubUrl', () => {
    it('should accept valid HTTPS GitHub URLs', () => {
      expect(isValidGitHubUrl('https://github.com/user/repo')).toBe(true);
      expect(isValidGitHubUrl('https://github.com/my-org/my-repo')).toBe(true);
      expect(isValidGitHubUrl('https://github.com/user/repo.js')).toBe(true);
    });

    it('should accept URLs with .git suffix', () => {
      expect(isValidGitHubUrl('https://github.com/user/repo.git')).toBe(true);
    });

    it('should accept SSH URLs (normalizes to HTTPS)', () => {
      expect(isValidGitHubUrl('git@github.com:user/repo.git')).toBe(true);
    });

    it('should reject non-GitHub URLs', () => {
      expect(isValidGitHubUrl('https://gitlab.com/user/repo')).toBe(false);
      expect(isValidGitHubUrl('https://bitbucket.org/user/repo')).toBe(false);
    });

    it('should reject invalid URLs', () => {
      expect(isValidGitHubUrl('not-a-url')).toBe(false);
      expect(isValidGitHubUrl('https://github.com/')).toBe(false);
      expect(isValidGitHubUrl('https://github.com/user')).toBe(false);
    });

    it('should reject URLs with extra path segments', () => {
      expect(isValidGitHubUrl('https://github.com/user/repo/tree/main')).toBe(false);
    });
  });

  describe('isValidBranchName', () => {
    it('should accept normal branch names', () => {
      expect(isValidBranchName('main')).toBe(true);
      expect(isValidBranchName('feature/DROP-123-thing')).toBe(true);
      expect(isValidBranchName('release-1.0.0')).toBe(true);
      expect(isValidBranchName('v2')).toBe(true);
    });

    it('should reject names starting with a dash (git option injection)', () => {
      expect(isValidBranchName('--upload-pack=/bin/sh')).toBe(false);
      expect(isValidBranchName('-x')).toBe(false);
    });

    it('should reject shell/whitespace/refspec metacharacters', () => {
      expect(isValidBranchName('main; rm -rf /')).toBe(false);
      expect(isValidBranchName('a b')).toBe(false);
      expect(isValidBranchName('feat~1')).toBe(false);
      expect(isValidBranchName('a..b')).toBe(false);
      expect(isValidBranchName('ref@{0}')).toBe(false);
      expect(isValidBranchName('a:b')).toBe(false);
    });

    it('should reject empty or overly long names', () => {
      expect(isValidBranchName('')).toBe(false);
      expect(isValidBranchName('a'.repeat(256))).toBe(false);
    });
  });

  /**
   * Real git, no execFile mocking — the only way to actually observe what
   * lands in .git/config. A file:// remote can't prove the token AUTHENTICATES
   * anything (that needs a live private repo + PAT, deferred — see the plan),
   * but it fully proves gitPull no longer writes the credential to disk,
   * since the write this pins against (`git remote set-url origin
   * https://TOKEN@…`) is gone from the code regardless of what the pull
   * actually authenticates against.
   */
  describe('gitPull does not write the token to disk (DROP-142 Fix 4)', () => {
    let tempDir: string;
    let originDir: string;
    let workDir: string;
    let branch: string;

    beforeAll(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-client-test-'));
      originDir = path.join(tempDir, 'origin');
      workDir = path.join(tempDir, 'work');

      await run('git', ['init', originDir]);
      await run('git', ['-C', originDir, 'config', 'user.email', 'test@example.com']);
      await run('git', ['-C', originDir, 'config', 'user.name', 'Test']);
      await fs.writeFile(path.join(originDir, 'file.txt'), 'hello\n');
      await run('git', ['-C', originDir, 'add', 'file.txt']);
      await run('git', ['-C', originDir, 'commit', '-m', 'initial commit']);
      branch = (
        await run('git', ['-C', originDir, 'rev-parse', '--abbrev-ref', 'HEAD'])
      ).stdout.trim();

      await run('git', ['clone', originDir, workDir]);
    }, 30000);

    afterAll(async () => {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('leaves the remote URL untouched and no token text in .git/config after a pull with a token', async () => {
      const beforeUrl = (
        await run('git', ['-C', workDir, 'remote', 'get-url', 'origin'])
      ).stdout.trim();

      const secretToken = 'ghp_realgitconfigcheck';
      await gitPull(workDir, branch, secretToken);

      const afterUrl = (
        await run('git', ['-C', workDir, 'remote', 'get-url', 'origin'])
      ).stdout.trim();
      expect(afterUrl).toBe(beforeUrl);

      const config = await fs.readFile(path.join(workDir, '.git', 'config'), 'utf-8');
      expect(config).not.toContain(secretToken);
    });

    it('still clones successfully with a token supplied', async () => {
      // Only proves the credential-helper args don't break an ordinary clone.
      // It canNOT prove the security property: a local remote needs no
      // credentials, so the helper never fires — that is asserted on the argv
      // directly, in the buildCloneArgs block below.
      const cloneDest = path.join(tempDir, 'cloned');
      await gitClone({ url: originDir, dest: cloneDest, branch, token: 'ghp_cloneprobe' });

      // Trimmed: git's autocrlf rewrites the newline on checkout under Windows.
      expect((await fs.readFile(path.join(cloneDest, 'file.txt'), 'utf-8')).trim()).toBe('hello');
    }, 30000);

    // The test above proves no token reaches disk, but a local file:// remote
    // never needs credentials, so it never actually invokes the helper — the
    // shell snippet's syntax and git's own env-var pickup were otherwise
    // unverified inference. This runs `git credential fill` directly with the
    // SAME -c args gitPull builds (git-client.ts) to prove, without any
    // network or a real repo, that git actually executes the `!`-prefixed
    // helper and that it reads GIT_ASKPASS_TOKEN from the child's env exactly
    // the way execFileAsync's `env` option passes it.
    //
    // Uses the EXPORTED constant and env builder, not a copy: a hand-copied
    // arg list would keep passing after someone changed the real helper
    // string, which is the one way this test could silently stop meaning
    // anything.
    it('the credential helper actually runs and reads the token from env (no repo, no network)', async () => {
      const { stdout } = await runWithStdin(
        [...CREDENTIAL_HELPER_ARGS, 'credential', 'fill'],
        credentialEnv('ghp_credentialhelperprobe'),
        'url=https://github.com/acme/app\n\n'
      );
      expect(stdout).toContain('username=x-access-token');
      expect(stdout).toContain('password=ghp_credentialhelperprobe');
    });

    describe('buildCloneArgs', () => {
      const secretToken = 'ghp_mustnotreachargv';
      const opts = {
        url: 'https://github.com/acme/private',
        dest: '/tmp/dest',
        branch: 'main',
        token: secretToken,
      };

      it('never puts the token in argv or in the clone URL', () => {
        const args = buildCloneArgs(opts);

        // The regression this pins: the URL used to be rewritten to
        // https://TOKEN@github.com/..., which git then persisted into the
        // cloned repo's .git/config forever.
        expect(args.join(' ')).not.toContain(secretToken);
        expect(args).toContain('https://github.com/acme/private');
      });

      it('passes the credential helper so an authenticated clone still works', () => {
        expect(buildCloneArgs(opts).slice(0, CREDENTIAL_HELPER_ARGS.length)).toEqual([
          ...CREDENTIAL_HELPER_ARGS,
        ]);
      });

      it('adds no credential machinery for a public clone', () => {
        expect(buildCloneArgs({ ...opts, token: undefined })[0]).toBe('clone');
      });
    });

    it('credentialEnv does not mutate process.env', () => {
      expect(process.env.GIT_ASKPASS_TOKEN).toBeUndefined();
      const env = credentialEnv('ghp_shouldnotescape');
      expect(env.GIT_ASKPASS_TOKEN).toBe('ghp_shouldnotescape');
      // The token must reach the ONE child that needs it, not every later
      // process the platform spawns.
      expect(process.env.GIT_ASKPASS_TOKEN).toBeUndefined();
    });
  });
});
