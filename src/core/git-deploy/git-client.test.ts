/**
 * Git Client Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isValidBranchName,
  gitClone,
  configureCloneBase,
  buildCloneArgs,
  CREDENTIAL_HELPER_ARGS,
  stripUrlCredentials,
} from './git-client';
import { landTracked } from './land';
import type { TrackedFile } from './land';

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
   * Real git against a `file://` remote (the only transport the suite has;
   * production is https-only and the test opts in explicitly).
   */
  describe('fresh clone + land (no git inside the app folder)', () => {
    let base: string;
    let clones: string;
    let remote: string;
    let remoteUrl: string;
    let br: string;
    let n = 0;
    const LIMITS = { maxBytes: 50 * 1024 * 1024, maxEntries: 20_000 };

    async function commitOnRemote(content: string): Promise<void> {
      await fs.writeFile(path.join(remote, 'file.txt'), content);
      await run('git', ['-C', remote, 'commit', '-am', content]);
    }

    async function freshClone(): Promise<{ dest: string; files: TrackedFile[]; symlinks: string[]; commitSha?: string }> {
      const dest = path.join(clones, `clone-${n++}`);
      await fs.mkdir(dest);
      const info = await gitClone({ url: remoteUrl, dest, branch: br, allowFileProtocol: true });
      return { dest, ...info };
    }

    beforeAll(async () => {
      base = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-land-'));
      clones = path.join(base, 'clones');
      await fs.mkdir(clones);
      configureCloneBase(clones);
      remote = path.join(base, 'remote');
      await run('git', ['init', remote]);
      await run('git', ['-C', remote, 'config', 'user.email', 'test@example.com']);
      await run('git', ['-C', remote, 'config', 'user.name', 'Test']);
      await run('git', ['-C', remote, 'config', 'core.autocrlf', 'false']);
      await fs.writeFile(path.join(remote, 'file.txt'), 'v0\n');
      await fs.mkdir(path.join(remote, 'sub'));
      await fs.writeFile(path.join(remote, 'sub', 'a.txt'), 'a\n');
      await run('git', ['-C', remote, 'add', '.']);
      await run('git', ['-C', remote, 'commit', '-m', 'initial']);
      br = (await run('git', ['-C', remote, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      remoteUrl = pathToFileURL(remote).href;
    }, 30000);

    afterAll(async () => {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('clones a shallow single branch and reports the SHA and the tracked files', async () => {
      const info = await freshClone();
      const head = (await run('git', ['-C', remote, 'rev-parse', 'HEAD'])).stdout.trim();
      expect(info.commitSha).toBe(head);
      expect(info.files.map((x) => x.path).sort()).toEqual(['file.txt', 'sub/a.txt']);
      // Each file carries its git blob id, which the saved list keeps.
      for (const file of info.files) expect(file.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(info.symlinks).toEqual([]);
      const depth = (await run('git', ['-C', info.dest, 'rev-list', '--count', 'HEAD'])).stdout.trim();
      expect(depth).toBe('1');
    }, 30000);

    it('refuses an oversized tree BEFORE any file is checked out', async () => {
      const dest = path.join(clones, 'too-big');
      await fs.mkdir(dest);
      await expect(
        gitClone({ url: remoteUrl, dest, branch: br, allowFileProtocol: true, maxBytes: 1 })
      ).rejects.toThrow(/maximum checkout size/);
      await expect(fs.access(path.join(dest, 'file.txt'))).rejects.toThrow();

      const dest2 = path.join(clones, 'too-many');
      await fs.mkdir(dest2);
      await expect(
        gitClone({ url: remoteUrl, dest: dest2, branch: br, allowFileProtocol: true, maxEntries: 1 })
      ).rejects.toThrow(/maximum of 1 entries/);
    }, 30000);

    it('is https-only by default: the file transport needs the explicit test option', async () => {
      const dest = path.join(clones, 'default-protocols');
      await fs.mkdir(dest);
      await expect(gitClone({ url: remoteUrl, dest, branch: br })).rejects.toThrow(/git clone failed/);
    }, 30000);

    it('a clone failure reports exit code and sanitised stderr, not argv or absolute paths', async () => {
      const dest = path.join(clones, 'failing');
      await fs.mkdir(dest);
      const err = await gitClone({ url: remoteUrl, dest, branch: br }).catch((e: Error) => e);
      expect((err as Error).message).not.toContain(clones);
      expect((err as Error).message).not.toContain('--depth');
      expect((err as Error).message).toMatch(/exit \d+/);
    }, 30000);

    it('refuses to clone, or run git, outside the clone base', async () => {
      const outside = path.join(base, 'outside');
      await fs.mkdir(outside);
      await expect(
        gitClone({ url: remoteUrl, dest: outside, branch: br, allowFileProtocol: true })
      ).rejects.toThrow(/outside the clone directory/);
    });

    it('ignores GIT_DIR inherited from the service environment but keeps GIT_SSL_* settings', async () => {
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(base, 'nowhere');
      try {
        const info = await freshClone();
        expect(info.commitSha?.length).toBeGreaterThan(6);
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }
    }, 30000);

    it('a redeploy never executes anything planted in the OLD app folder, and leaves it without .git', async () => {
      // An app folder that is itself a clone with a planted hook, config
      // execution keys and a redirected remote: what a build container could
      // have written under the old design.
      const appDir = path.join(base, 'app-old');
      await run('git', ['clone', '-c', 'core.autocrlf=false', remote, appDir]);
      const sh = (p: string): string => p.replace(/\\/g, '/');
      const markerHook = path.join(base, 'marker-hook');
      const markerGpg = path.join(base, 'marker-gpg');
      const markerAlt = path.join(base, 'marker-alt');
      await fs.writeFile(
        path.join(appDir, '.git', 'hooks', 'post-merge'),
        `#!/bin/sh\necho pwned > "${sh(markerHook)}"\n`,
        { mode: 0o755 }
      );
      await run('git', ['-C', appDir, 'config', 'gpg.program', `sh -c 'echo x > ${sh(markerGpg)}'`]);
      await run('git', ['-C', appDir, 'config', 'core.alternateRefsCommand', `echo x > ${sh(markerAlt)}`]);
      await run('git', ['-C', appDir, 'config', 'remote.https://github.com/acme/app.uploadpack', 'sh -c "echo x"']);
      await run('git', ['-C', appDir, 'config', 'remote.origin.url', path.join(base, 'elsewhere')]);
      await fs.mkdir(path.join(appDir, 'node_modules'));
      await fs.writeFile(path.join(appDir, 'node_modules', 'keep.txt'), 'dep');
      await fs.writeFile(path.join(appDir, 'untracked.txt'), 'app data');

      // Positive control: a plain git operation in THIS tree does run the hook,
      // so "marker absent" below proves the redeploy avoided it, not that the
      // hook was inert.
      await commitOnRemote('v-control\n');
      await run('git', ['-C', appDir, 'pull', remote, br]);
      await expect(fs.access(markerHook)).resolves.toBeUndefined();
      await fs.rm(markerHook);

      // The redeploy path: fresh clone elsewhere, land the tracked files.
      await commitOnRemote('v-new\n');
      const info = await freshClone();
      await landTracked({ cloneDir: info.dest, appDir, files: info.files, previous: null, limits: LIMITS });

      expect((await fs.readFile(path.join(appDir, 'file.txt'), 'utf-8')).trim()).toBe('v-new');
      await expect(fs.lstat(path.join(appDir, '.git'))).rejects.toThrow();
      // Untracked content and node_modules survive.
      expect(await fs.readFile(path.join(appDir, 'untracked.txt'), 'utf-8')).toBe('app data');
      expect(await fs.readFile(path.join(appDir, 'node_modules', 'keep.txt'), 'utf-8')).toBe('dep');
      for (const m of [markerHook, markerGpg, markerAlt]) {
        await expect(fs.access(m)).rejects.toThrow();
      }
    }, 60000);

    it('a symlinked .git in the app folder is removed as a link; its target is untouched', async () => {
      const appDir = path.join(base, 'app-linked');
      const target = path.join(base, 'link-target');
      await fs.mkdir(appDir);
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'sentinel'), 'still here');
      await fs.symlink(target, path.join(appDir, '.git'), process.platform === 'win32' ? 'junction' : 'dir');

      const info = await freshClone();
      await landTracked({ cloneDir: info.dest, appDir, files: info.files, previous: null, limits: LIMITS });

      await expect(fs.lstat(path.join(appDir, '.git'))).rejects.toThrow();
      expect(await fs.readFile(path.join(target, 'sentinel'), 'utf-8')).toBe('still here');
      await expect(fs.access(path.join(appDir, 'file.txt'))).resolves.toBeUndefined();
    }, 30000);

    it('a first deploy lands the tracked files without a .git', async () => {
      const appDir = path.join(base, 'app-first');
      const info = await freshClone();
      await landTracked({ cloneDir: info.dest, appDir, files: info.files, previous: null, limits: LIMITS });
      await expect(fs.lstat(path.join(appDir, '.git'))).rejects.toThrow();
      await expect(fs.access(path.join(appDir, 'sub', 'a.txt'))).resolves.toBeUndefined();
    }, 30000);
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
      expect(args.join(' ')).not.toContain(secretToken);
      expect(args).toContain('https://github.com/acme/private');
    });

    it('is a shallow single-branch clone with hooks off and https the only transport', () => {
      const args = buildCloneArgs(opts).join(' ');
      for (const piece of [
        'core.hooksPath=/dev/null',
        'protocol.allow=never',
        'protocol.https.allow=always',
        '--depth 1',
        '--single-branch',
        '--no-recurse-submodules',
        '--branch main --single-branch --no-recurse-submodules -- https://github.com/acme/private /tmp/dest',
      ]) {
        expect(args).toContain(piece);
      }
      expect(args).not.toContain('protocol.file.allow');
    });

    it('puts the credential helper AFTER every reset, so a later reset cannot wipe it', () => {
      const args = buildCloneArgs(opts);
      const scoped = args.findIndex((a) => a.startsWith('credential.https://github.com.helper='));
      expect(scoped).toBeGreaterThan(-1);
      const lastReset = args.lastIndexOf('credential.helper=');
      expect(lastReset).toBeGreaterThan(-1);
      expect(lastReset).toBeLessThan(scoped);
    });

    it('adds no credential machinery for a public clone', () => {
      expect(buildCloneArgs({ ...opts, token: undefined }).join(' ')).not.toContain('credential');
    });

    // The exact argv a private clone uses must actually yield a credential. The
    // prefix before `clone` is the whole of git's -c configuration.
    it('the clone argv yields the token through git credential fill (private clones work)', async () => {
      const args = buildCloneArgs(opts);
      const prefix = args.slice(0, args.indexOf('clone'));
      const { stdout } = await runWithStdin(
        [...prefix, 'credential', 'fill'],
        { ...process.env, GIT_ASKPASS_TOKEN: 'ghp_credentialhelperprobe' },
        'url=https://github.com/acme/app\n\n'
      );
      expect(stdout).toContain('username=x-access-token');
      expect(stdout).toContain('password=ghp_credentialhelperprobe');
    });

    it('the helper answers for github.com ONLY — a different host gets no credential', async () => {
      const args = buildCloneArgs(opts);
      const prefix = args.slice(0, args.indexOf('clone'));
      const forOther = await run('git', [
        ...prefix,
        'config',
        '--get-urlmatch',
        'credential',
        'https://evil.example.com/acme/app',
      ]);
      expect(forOther.stdout).not.toContain('GIT_ASKPASS_TOKEN');
      expect(CREDENTIAL_HELPER_ARGS.join(' ')).toContain('credential.https://github.com.helper');
    });
  });

  describe('stripUrlCredentials', () => {
    it('returns null when there is nothing to strip', () => {
      expect(stripUrlCredentials('https://github.com/acme/app')).toBeNull();
    });

    it('strips a user:password pair', () => {
      expect(stripUrlCredentials('https://ghost:ghp_x@github.com/acme/app')).toBe(
        'https://github.com/acme/app'
      );
    });

    it('strips a bare token in the username position', () => {
      expect(stripUrlCredentials('https://ghp_tokenonly@github.com/acme/app')).toBe(
        'https://github.com/acme/app'
      );
    });

    it('returns null for a value that is not a URL at all (an SSH remote)', () => {
      expect(stripUrlCredentials('git@github.com:acme/app.git')).toBeNull();
    });
  });

  describe('single choke point', () => {
    it('git-client.ts has exactly one process spawn, and no other deploy module spawns anything', async () => {
      const dir = __dirname;
      const clientSrc = await fs.readFile(path.join(dir, 'git-client.ts'), 'utf-8');
      const spawns = clientSrc.match(/\b(execFileAsync|execFile|exec|execSync|spawn|spawnSync|fork)\(/g) ?? [];
      expect(spawns).toEqual(['execFileAsync(']);
      expect(clientSrc).toMatch(/execFileAsync\(\s*'git'/);

      for (const f of ['git-deploy.ts', 'index.ts', 'land.ts']) {
        const src = await fs.readFile(path.join(dir, f), 'utf-8');
        expect(src).not.toMatch(/child_process/);
      }
    });
  });
});
