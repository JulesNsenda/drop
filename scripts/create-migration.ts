/**
 * Migration scaffolder
 *
 * Creates a new numbered .sql migration in src/managers/app/migrations/.
 * The numeric prefix (NNN_) determines apply order — see MigrationRunner.
 *
 * Usage: npm run db:migrate:create -- <name>
 *   e.g. npm run db:migrate:create -- add_deployments_index
 */

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'managers', 'app', 'migrations');

function nextPrefix(): string {
  const existing = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => parseInt(f.match(/^(\d+)/)![1], 10));

  const max = existing.length > 0 ? Math.max(...existing) : 0;
  return String(max + 1).padStart(3, '0');
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function main(): void {
  const rawName = process.argv.slice(2).join(' ').trim();
  if (!rawName) {
    console.error('Error: migration name is required');
    console.error('Usage: npm run db:migrate:create -- <name>');
    process.exit(1);
  }

  const slug = slugify(rawName);
  if (!slug) {
    console.error('Error: migration name must contain at least one alphanumeric character');
    process.exit(1);
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  }

  const prefix = nextPrefix();
  const fileName = `${prefix}_${slug}.sql`;
  const filePath = path.join(MIGRATIONS_DIR, fileName);

  if (fs.existsSync(filePath)) {
    console.error(`Error: migration already exists: ${fileName}`);
    process.exit(1);
  }

  const template = `-- Migration ${prefix}: ${rawName}
-- Migrations run inside a transaction (see MigrationRunner.runMigration).
-- Make statements idempotent (IF NOT EXISTS / CREATE OR REPLACE) so a
-- partial/failed apply can be retried safely.

`;

  fs.writeFileSync(filePath, template, 'utf-8');
  console.log(`Created migration: ${path.relative(process.cwd(), filePath)}`);
}

main();
