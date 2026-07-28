/**
 * Which apps get a database, and — just as important — which don't.
 *
 * The bug this pins: an app built the way an agent builds one (Express, the
 * `pg` client, hand-written SQL, no drop.yaml, no ORM config file) got NO
 * database and started with no DATABASE_URL, because detection only ever
 * looked at drop.yaml and ORM *config files* — never at dependencies. A todo
 * app deployed through the MCP connector hit exactly this and logged
 * "[db] connection source: NOT FOUND".
 *
 * The other half is the guard. Inference must never overrule an operator who
 * set their own DATABASE_URL secret: `dbEnvVars` is spread AFTER
 * `secretEnvVars` when the start env is assembled, so provisioning on a hunch
 * would override that secret and silently repoint a live app from its real
 * database at a freshly-created empty one.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';

describe('appNeedsDatabase', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appPath: string;

  /** Call the private detector the way the deploy path does. */
  const needsDb = (detectionDatabase?: boolean | string): Promise<boolean> =>
    (platform as any).appNeedsDatabase('todo-app', appPath, detectionDatabase);

  const writePackageJson = (pkg: Record<string, unknown>): Promise<void> =>
    fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify(pkg), 'utf-8');

  /** No secrets set for any app, which is the common case. */
  const withNoSecrets = () => {
    (platform as any).secretManager = { get: jest.fn().mockReturnValue(null) };
  };

  const withDatabaseUrlSecret = (value = 'postgresql://elsewhere/prod') => {
    (platform as any).secretManager = {
      get: jest.fn((_app: string, key: string) => (key === 'DATABASE_URL' ? value : null)),
    };
  };

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-db-detect-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', 'todo-app');
    await fs.mkdir(appPath, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
    withNoSecrets();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('dependencies in package.json', () => {
    it('provisions for an Express app using the pg client — the reported bug', async () => {
      await writePackageJson({
        name: 'todo-app',
        dependencies: { express: '^4.19.2', pg: '^8.11.5' },
      });
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it.each([
      ['pg-promise'],
      ['postgres'],
      ['slonik'],
      ['@prisma/client'],
      ['drizzle-orm'],
      ['knex'],
      ['sequelize'],
      ['typeorm'],
      ['objection'],
      ['@mikro-orm/postgresql'],
    ])('provisions for an app depending on %s', async (client) => {
      await writePackageJson({ name: 'todo-app', dependencies: { [client]: '^1.0.0' } });
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('counts devDependencies too — prisma is conventionally a dev dep', async () => {
      await writePackageJson({
        name: 'todo-app',
        dependencies: { express: '^4.19.2' },
        devDependencies: { prisma: '^5.0.0' },
      });
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('does not provision for an app with no database client', async () => {
      await writePackageJson({
        name: 'todo-app',
        dependencies: { express: '^4.19.2', morgan: '^1.10.0' },
      });
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it.each([['mysql2'], ['mysql'], ['mongoose'], ['better-sqlite3'], ['sqlite3']])(
      'does not hand a postgres:// URL to a %s app',
      async (client) => {
        await writePackageJson({ name: 'todo-app', dependencies: { [client]: '^1.0.0' } });
        await expect(needsDb(undefined)).resolves.toBe(false);
      }
    );

    it('does not provision when there is no package.json at all', async () => {
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it('does not throw on an unparseable package.json', async () => {
      await fs.writeFile(path.join(appPath, 'package.json'), '{ not json', 'utf-8');
      await expect(needsDb(undefined)).resolves.toBe(false);
    });
  });

  describe('ORM config files (pre-existing behavior)', () => {
    it('provisions on prisma/schema.prisma with no dependency at all', async () => {
      await fs.mkdir(path.join(appPath, 'prisma'), { recursive: true });
      await fs.writeFile(path.join(appPath, 'prisma', 'schema.prisma'), '', 'utf-8');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('provisions on knexfile.js', async () => {
      await fs.writeFile(path.join(appPath, 'knexfile.js'), '', 'utf-8');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });
  });

  describe('explicit drop.yaml declaration', () => {
    it.each([[true], ['postgres'], ['sqlite']])('provisions on database: %s', async (declared) => {
      await expect(needsDb(declared as boolean | string)).resolves.toBe(true);
    });
  });

  describe('a DATABASE_URL in the drop.yaml env: block', () => {
    const writeDropYaml = (body: string): Promise<void> =>
      fs.writeFile(path.join(appPath, 'drop.yaml'), body, 'utf-8');

    // `dbEnvVars` is spread after the drop.yaml `env:` base layer too, not just
    // after secrets — so this layer needs the same protection the secret gets.
    it('blocks inference from a dependency', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      await writeDropYaml('type: express\nenv:\n  DATABASE_URL: postgresql://elsewhere/prod\n');
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it('blocks inference from an ORM config file', async () => {
      await fs.writeFile(path.join(appPath, 'knexfile.js'), '', 'utf-8');
      await writeDropYaml('type: express\nenv:\n  DATABASE_URL: postgresql://elsewhere/prod\n');
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it('does NOT block an explicit database: postgres in the same file', async () => {
      await writeDropYaml(
        'type: express\ndatabase: postgres\nenv:\n  DATABASE_URL: postgresql://elsewhere/prod\n'
      );
      await expect(needsDb('postgres')).resolves.toBe(true);
    });

    it('an unrelated env: block does not block', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      await writeDropYaml('type: express\nenv:\n  NODE_ENV: production\n');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('an empty DATABASE_URL value does not block', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      await writeDropYaml('type: express\nenv:\n  DATABASE_URL: "   "\n');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('an invalid drop.yaml fails soft and still provisions', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      await writeDropYaml('type: express\nnot_a_real_key: nope\n');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });
  });

  describe('an operator-set DATABASE_URL secret', () => {
    it('blocks inference from a dependency, so the app keeps its own database', async () => {
      await writePackageJson({
        name: 'todo-app',
        dependencies: { express: '^4.19.2', pg: '^8.11.5' },
      });
      withDatabaseUrlSecret();
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it('blocks inference from an ORM config file too', async () => {
      await fs.writeFile(path.join(appPath, 'knexfile.js'), '', 'utf-8');
      withDatabaseUrlSecret();
      await expect(needsDb(undefined)).resolves.toBe(false);
    });

    it('does NOT block an explicit drop.yaml database: postgres', async () => {
      withDatabaseUrlSecret();
      await expect(needsDb('postgres')).resolves.toBe(true);
    });

    it('an empty secret value is not a declaration and does not block', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      withDatabaseUrlSecret('');
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('a secret manager that throws fails soft, preserving provisioning', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      (platform as any).secretManager = {
        get: jest.fn(() => {
          throw new Error('store unavailable');
        }),
      };
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('an absent secret manager fails soft the same way', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      (platform as any).secretManager = null;
      await expect(needsDb(undefined)).resolves.toBe(true);
    });

    it('is checked against the app being deployed, not a fixed name', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { pg: '^8.11.5' } });
      const get = jest.fn().mockReturnValue(null);
      (platform as any).secretManager = { get };
      await needsDb(undefined);
      expect(get).toHaveBeenCalledWith('todo-app', 'DATABASE_URL');
    });
  });
});
