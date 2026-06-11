/**
 * Copy non-TS build assets into dist after tsc.
 *
 * tsc only emits .js/.d.ts, but the migration runner reads its .sql files
 * from __dirname at runtime (which is dist/... in a built deployment). Copy
 * them so `npm start` can apply migrations on a fresh database.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function copyByExt(srcDir, destDir, ext) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry.endsWith(ext)) {
      fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
      count++;
    }
  }
  return count;
}

const migrationsSrc = path.join(root, 'src', 'managers', 'app', 'migrations');
const migrationsDest = path.join(root, 'dist', 'managers', 'app', 'migrations');
const n = copyByExt(migrationsSrc, migrationsDest, '.sql');

console.log(`copy-assets: copied ${n} migration file(s) to dist`);
