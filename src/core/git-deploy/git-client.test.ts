/**
 * Git Client Tests
 */

import {
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isValidBranchName,
} from './git-client';

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
});
