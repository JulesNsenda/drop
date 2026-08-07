#!/usr/bin/env node
/**
 * Version-bump helper: `npm run release <version>`.
 *
 * Bumps the ROOT package.json (and package-lock.json) and stamps today's date
 * into the matching CHANGELOG heading. Deliberately does NOT tag, commit or
 * push -- tagging is a consented act, and on this repo it is also the thing
 * that publishes a release, so it stays in the operator's hands.
 *
 * Bump the root package.json ONLY. The version reaches the UI as a build-time
 * Vite `define` (__DROP_VERSION__) read from this file by both vite configs,
 * and the API reads it via getPlatformVersion(). Editing any other copy is how
 * DROP-077 happened: three components carried a hardcoded version through two
 * release cuts while the API reported a different one.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

const die = (msg) => {
  console.error(`\x1b[31merror\x1b[0m ${msg}`);
  process.exit(1);
};

const version = process.argv[2];
if (!version) die('usage: npm run release <version>   (e.g. npm run release 1.0.1)');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  die(`'${version}' is not a valid semver version (expected X.Y.Z or X.Y.Z-suffix)`);
}

// A dirty tree means the bump commit would sweep unrelated work in with it.
const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (status) die(`working tree is dirty -- commit or stash first:\n${status}`);

// Refuse before touching anything if the changelog section is missing. The
// release workflow enforces the same rule, but it only runs AFTER the tag is
// pushed and public; failing here is free.
let changelog = fs.readFileSync(CHANGELOG, 'utf8');
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*$`, 'm');
if (!heading.test(changelog)) {
  die(
    `CHANGELOG.md has no '## [${version}]' section.\n` +
      `  Release notes are extracted from it, so write the section first.`
  );
}

// Stamp today's date so a placeholder can never ship as the public release date.
const today = new Date().toISOString().slice(0, 10);
changelog = changelog.replace(heading, `## [${version}] - ${today}`);
fs.writeFileSync(CHANGELOG, changelog);

// npm version updates package.json AND both version fields in a
// lockfileVersion-3 package-lock.json. --no-git-tag-version: we do not tag.
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log(`\nBumped to ${version} and dated the CHANGELOG section ${today}.`);
console.log('\nNext:');
console.log(`  git commit -am "chore(release): ${version}"`);
console.log('  # open a PR; once it is MERGED, tag the merge commit -- not this branch:');
console.log(`  git checkout main && git pull && git tag v${version} && git push origin v${version}`);
console.log('\nPushing the tag runs .github/workflows/release.yml, which publishes the release.');
console.log('Tagging a pre-merge commit would publish code that production is not running.');
