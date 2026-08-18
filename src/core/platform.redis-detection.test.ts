/**
 * Which apps get managed Redis — specifically DROP-151's AppConfig.services
 * intent, which sits ABOVE both drop.yaml's `redis:` declaration and
 * dependency inference. See appServiceIntent's own doc comment in
 * platform.ts for why intent outranks the manifest, and
 * platform.database-detection.test.ts for the symmetric Postgres coverage —
 * appNeedsRedis's pre-existing drop.yaml/dependency precedence is exercised
 * there in spirit and via platform.restart.test.ts's "Redis on the restart
 * path" describe block; this file only adds what DROP-151 changed: the
 * `appName` parameter and the intent that now gates everything else.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';

describe('appNeedsRedis', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appPath: string;

  /** Call the private detector the way provisionRedisEnvVars does. */
  const needsRedis = (): Promise<boolean> =>
    (platform as any).appNeedsRedis('todo-app', appPath);

  const writePackageJson = (pkg: Record<string, unknown>): Promise<void> =>
    fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify(pkg), 'utf-8');

  const writeDropYaml = (body: string): Promise<void> =>
    fs.writeFile(path.join(appPath, 'drop.yaml'), body, 'utf-8');

  /** DROP-151: stub AppConfigService the way appServiceIntent reads it. */
  const withServiceIntent = (services: Record<string, 'attached' | 'detached'>) => {
    (platform as any).appConfigService = {
      getConfig: jest.fn().mockReturnValue({ services }),
    };
  };

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-redis-detect-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', 'todo-app');
    await fs.mkdir(appPath, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('pre-existing precedence (drop.yaml, then dependency inference)', () => {
    it('opts in on redis: true with no dependency at all', async () => {
      await writeDropYaml('redis: true\n');
      await expect(needsRedis()).resolves.toBe(true);
    });

    it('opts out on redis: false even with a redis client dependency', async () => {
      await writeDropYaml('redis: false\n');
      await writePackageJson({ name: 'todo-app', dependencies: { ioredis: '^5.0.0' } });
      await expect(needsRedis()).resolves.toBe(false);
    });

    it('infers from a redis client dependency when drop.yaml has no opinion', async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { ioredis: '^5.0.0' } });
      await expect(needsRedis()).resolves.toBe(true);
    });

    it('does not provision with no signal at all', async () => {
      await expect(needsRedis()).resolves.toBe(false);
    });
  });

  // DROP-151: AppConfig.services.redis sits ABOVE the drop.yaml `redis:` key
  // and above dependency inference — same precedence, same reasoning, as the
  // Postgres predicate.
  describe('AppConfig.services intent (DROP-151)', () => {
    it("'attached' wins with no signal at all", async () => {
      withServiceIntent({ redis: 'attached' });
      await expect(needsRedis()).resolves.toBe(true);
    });

    it("'detached' overrides an explicit drop.yaml redis: true declaration", async () => {
      await writeDropYaml('redis: true\n');
      withServiceIntent({ redis: 'detached' });
      await expect(needsRedis()).resolves.toBe(false);
    });

    it("'detached' overrides an inferred redis client dependency", async () => {
      await writePackageJson({ name: 'todo-app', dependencies: { ioredis: '^5.0.0' } });
      withServiceIntent({ redis: 'detached' });
      await expect(needsRedis()).resolves.toBe(false);
    });

    it('an intent recorded for a different service key is ignored', async () => {
      // Only 'postgres' is recorded — 'redis' has no entry, so this must fall
      // through to the (here, negative) precedence below it unaffected.
      withServiceIntent({ postgres: 'attached' });
      await expect(needsRedis()).resolves.toBe(false);
    });
  });
});
