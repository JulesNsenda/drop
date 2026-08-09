/**
 * upload-paths tests (DROP-141).
 */

import {
  isVcsMetadataComponent,
  APP_NAME_RE,
  normalizeEntryPath,
  PathNormalizationError,
  stripCommonRoot,
  commonRootName,
  findCollisions,
  DEFAULT_EXCLUDES,
  isExcludedByDefault,
} from './upload-paths';

describe('isVcsMetadataComponent', () => {
  it('matches ".git" case-insensitively', () => {
    expect(isVcsMetadataComponent('.git')).toBe(true);
    expect(isVcsMetadataComponent('.GIT')).toBe(true);
    expect(isVcsMetadataComponent('.Git')).toBe(true);
  });

  it('matches Windows aliases: trailing dots/spaces, ADS suffix, 8.3 short name', () => {
    expect(isVcsMetadataComponent('.git.')).toBe(true);
    expect(isVcsMetadataComponent('.git ')).toBe(true);
    expect(isVcsMetadataComponent('.git::$DATA')).toBe(true);
    expect(isVcsMetadataComponent('GIT~1')).toBe(true);
  });

  it('does not match names that merely contain "git"', () => {
    expect(isVcsMetadataComponent('.gitignore')).toBe(false);
    expect(isVcsMetadataComponent('gitconfig')).toBe(false);
    expect(isVcsMetadataComponent('src')).toBe(false);
  });
});

describe('APP_NAME_RE', () => {
  it('accepts alphanumeric names with hyphens/underscores', () => {
    expect(APP_NAME_RE.test('my-app')).toBe(true);
    expect(APP_NAME_RE.test('my_app123')).toBe(true);
    expect(APP_NAME_RE.test('App1')).toBe(true);
    expect(APP_NAME_RE.test('a')).toBe(true);
  });

  it('rejects a dotted name (the looser git-deploy.ts rule would accept it)', () => {
    expect(APP_NAME_RE.test('my.app')).toBe(false);
  });

  it('rejects a leading hyphen/underscore/dot, empty strings, and names over 64 chars', () => {
    expect(APP_NAME_RE.test('-app')).toBe(false);
    expect(APP_NAME_RE.test('_app')).toBe(false);
    expect(APP_NAME_RE.test('.app')).toBe(false);
    expect(APP_NAME_RE.test('')).toBe(false);
    expect(APP_NAME_RE.test('a'.repeat(65))).toBe(false);
    expect(APP_NAME_RE.test('a'.repeat(64))).toBe(true);
  });
});

describe('normalizeEntryPath', () => {
  it('strips a leading slash', () => {
    expect(normalizeEntryPath('/a/b.txt')).toBe('a/b.txt');
  });

  it('strips "./" prefixes and interior "." segments', () => {
    expect(normalizeEntryPath('./a.txt')).toBe('a.txt');
    expect(normalizeEntryPath('a/./b.txt')).toBe('a/b.txt');
  });

  it('collapses repeated slashes', () => {
    expect(normalizeEntryPath('a//b.txt')).toBe('a/b.txt');
    expect(normalizeEntryPath('a///b///c.txt')).toBe('a/b/c.txt');
  });

  it('strips a trailing slash', () => {
    expect(normalizeEntryPath('a/b/')).toBe('a/b');
  });

  it('throws on a ".." segment', () => {
    expect(() => normalizeEntryPath('a/../b.txt')).toThrow(PathNormalizationError);
    expect(() => normalizeEntryPath('../etc/passwd')).toThrow(PathNormalizationError);
  });

  it('throws on a backslash', () => {
    expect(() => normalizeEntryPath('a\\b.txt')).toThrow(PathNormalizationError);
  });
});

describe('a realistic checked-out-repo folder selection', () => {
  // Pins what an end-to-end run of the browser glue was measured to produce.
  // This is the single most load-bearing behaviour in the upload path: the
  // server now REJECTS an archive containing a `.git` component, so if the
  // exclusion regresses, every folder drop from a real repo 400s. Kept pure
  // (the glue itself needs File/Blob/CompressionStream and cannot be imported
  // under `testEnvironment: 'node'`).
  const picked = [
    'my-app/package.json',
    'my-app/src/index.js',
    'my-app/.gitignore',
    'my-app/.git/config',
    'my-app/.git/HEAD',
    'my-app/node_modules/left-pad/index.js',
  ];

  it('excludes .git and node_modules, keeps .gitignore, and strips the root', () => {
    const normalized = picked.map(normalizeEntryPath);
    const kept = normalized.filter(p => !isExcludedByDefault(p));

    // `.gitignore` surviving is the assertion that the exclusion does not
    // over-match — a `startsWith('.git')` bug would silently drop it.
    expect(stripCommonRoot(kept)).toEqual(['package.json', 'src/index.js', '.gitignore']);
    expect(commonRootName(normalized)).toBe('my-app');
    expect(normalized.filter(isExcludedByDefault)).toEqual([
      'my-app/.git/config',
      'my-app/.git/HEAD',
      'my-app/node_modules/left-pad/index.js',
    ]);
  });

  it('leaves no .git component for the server guard to reject', () => {
    const kept = picked.map(normalizeEntryPath).filter(p => !isExcludedByDefault(p));
    for (const p of stripCommonRoot(kept)) {
      expect(p.split('/').some(isVcsMetadataComponent)).toBe(false);
    }
  });
});

describe('commonRootName', () => {
  it('names the root that stripCommonRoot removes', () => {
    const paths = ['app/src/index.ts', 'app/package.json'];
    expect(commonRootName(paths)).toBe('app');
    expect(stripCommonRoot(paths)).toEqual(['src/index.ts', 'package.json']);
  });

  it('returns null wherever stripCommonRoot strips nothing', () => {
    // The two must never disagree: the dashboard derives the app NAME from
    // this while the uploaded paths lose the root via stripCommonRoot, so a
    // divergence would name the app after a directory still present in the
    // archive (or vice versa).
    for (const paths of [
      ['index.html'], // no directory at all
      ['app1/x.txt', 'app10/y.txt'], // filename prefix, not a shared segment
      ['a/x.txt', 'b/y.txt'], // different roots
      ['top.txt', 'app/nested.txt'], // mixed top-level and nested
      [], // empty selection
    ]) {
      expect(commonRootName(paths)).toBeNull();
      expect(stripCommonRoot(paths)).toEqual(paths);
    }
  });
});

describe('stripCommonRoot', () => {
  it('strips one shared leading directory for a single nested file', () => {
    expect(stripCommonRoot(['folder/sub/file.txt'])).toEqual(['sub/file.txt']);
  });

  it('leaves a single flat file (no directory) unchanged', () => {
    expect(stripCommonRoot(['file.txt'])).toEqual(['file.txt']);
  });

  it('strips a shared root across multiple files', () => {
    expect(stripCommonRoot(['app/index.html', 'app/src/x.js'])).toEqual(['index.html', 'src/x.js']);
  });

  it('does not treat a filename-prefix match as a shared root', () => {
    // "app1" and "app10" share characters but are different directory
    // segments -- a naive longest-common-prefix algorithm would wrongly
    // strip "app1" from both.
    expect(stripCommonRoot(['app1/x', 'app10/y'])).toEqual(['app1/x', 'app10/y']);
  });

  it('leaves paths unchanged when one entry has no directory at all', () => {
    expect(stripCommonRoot(['file.txt', 'folder/x.js'])).toEqual(['file.txt', 'folder/x.js']);
  });

  it('handles an empty list', () => {
    expect(stripCommonRoot([])).toEqual([]);
  });
});

describe('findCollisions', () => {
  it('finds a case-insensitive collision', () => {
    expect(findCollisions(['README.md', 'readme.md'])).toEqual([['README.md', 'readme.md']]);
  });

  it('finds an NFC/NFD Unicode-normalization collision (Safari webkitRelativePath yields NFD on macOS)', () => {
    // Built from explicit code points rather than a literal accented
    // character in the source, so the two variants can't accidentally end
    // up byte-identical via editor/tool normalization of this file.
    const nfc = 'café.txt'; // precomposed 'e with acute' (U+00E9)
    const nfd = 'café.txt'; // 'e' (U+0065) + combining acute accent (U+0301)
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize('NFC')).toBe(nfc);
    expect(nfd.normalize('NFC')).toBe(nfc);
    expect(findCollisions([nfc, nfd])).toEqual([[nfc, nfd]]);
  });

  it('reports no collisions for genuinely distinct paths', () => {
    expect(findCollisions(['a.txt', 'b.txt', 'dir/a.txt'])).toEqual([]);
  });

  it('reports a pair per additional duplicate, anchored on the first occurrence', () => {
    expect(findCollisions(['A.txt', 'a.txt', 'A.TXT'])).toEqual([
      ['A.txt', 'a.txt'],
      ['A.txt', 'A.TXT'],
    ]);
  });
});

describe('DEFAULT_EXCLUDES / isExcludedByDefault', () => {
  it('includes node_modules', () => {
    expect(DEFAULT_EXCLUDES).toContain('node_modules');
  });

  it('excludes a nested .git directory, case-insensitively', () => {
    expect(isExcludedByDefault('repo/.git/config')).toBe(true);
    expect(isExcludedByDefault('repo/.GIT/config')).toBe(true);
  });

  it('excludes node_modules at any depth', () => {
    expect(isExcludedByDefault('node_modules/foo/index.js')).toBe(true);
    expect(isExcludedByDefault('packages/api/node_modules/foo/index.js')).toBe(true);
  });

  it('does not exclude ordinary paths', () => {
    expect(isExcludedByDefault('src/app.js')).toBe(false);
    expect(isExcludedByDefault('.gitignore')).toBe(false);
  });
});
