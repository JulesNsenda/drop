/**
 * `strictManifest` — the fail-CLOSED half of DROP-130 item 9 (its open
 * question Q1).
 *
 * Item 9 made an unparseable `drop.yaml` VISIBLE (one deduped warning per
 * unchanged file). It did not make it consequential: every `parseDropYaml`
 * caller in `platform.ts` reads `cfg.success ? cfg.config?.x : undefined`,
 * which is correct field by field and wrong in aggregate — on a parse failure
 * the manifest is discarded whole, `secrets:` therefore reads as "none
 * declared", `planSecretPreflight` finds nothing missing, and the app starts
 * with none of the configuration its author wrote. PRD-051 exists to stop
 * exactly that, and a typo in a secret name walks straight past it.
 *
 * The flag defaults OFF, so the first test here is the one that matters most
 * for anyone upgrading: today's behaviour is unchanged.
 *
 * These call `buildStartSpec` directly on a constructed-but-never-started
 * platform, the way `platform.readiness.test.ts` does — the constructor
 * performs no I/O, and the manifest check runs before the spec builder touches
 * dependencies, log paths or a venv, so nothing else needs mocking.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createPlatform, DropPlatform } from './platform';
import { AppManifestInvalidError, needsConfigAction, needsConfigDetail } from '../api/platform-ops';
import { AppNeedsConfigError } from '../api/platform-ops';
import { __resetDropYamlParseWarnings } from './detector/drop-yaml-parser';
import { DetectionResult } from './detector';

/** A manifest that is well-formed YAML but not a valid drop.yaml. */
const INVALID_MANIFEST = 'type: nodejs\nnot_a_real_field: 1\n';

describe('strictManifest — refusing to start on an unparseable drop.yaml', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appPath: string;

  const detection = {
    type: 'nodejs',
    confidence: 1,
    startCommand: 'node index.js',
  } as unknown as DetectionResult;

  /** Invoke the private spec builder with the arguments the start path passes. */
  const buildSpec = (p: DropPlatform) =>
    (p as unknown as {
      buildStartSpec: (
        appName: string,
        appPath: string,
        detection: DetectionResult,
        port: number,
        dataDir: string,
        dbEnvVars: Record<string, string>
      ) => Promise<unknown>;
    }).buildStartSpec('demo', appPath, detection, 3001, path.join(tempDir, 'data'), {});

  const makePlatform = (strictManifest: boolean) =>
    createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      strictManifest,
    });

  beforeEach(async () => {
    __resetDropYamlParseWarnings();
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-strict-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appPath = path.join(tempDir, 'apps', 'demo');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'console.log(1);\n');
  });

  afterEach(async () => {
    if (platform?.isActive()) await platform.stop();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('is OFF by default, so an app with a malformed manifest still starts', async () => {
    // The upgrade-safety property. An app whose manifest is ALREADY malformed
    // deploys today; flipping this on without warning would refuse it, and the
    // size of that population cannot be known from here — which is why
    // DROP-130 deferred the decision to live evidence rather than shipping it.
    await fs.writeFile(path.join(appPath, 'drop.yaml'), INVALID_MANIFEST);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    await expect(buildSpec(platform)).resolves.toBeDefined();
  });

  it('refuses once the flag is on', async () => {
    await fs.writeFile(path.join(appPath, 'drop.yaml'), INVALID_MANIFEST);
    platform = makePlatform(true);

    await expect(buildSpec(platform)).rejects.toBeInstanceOf(AppManifestInvalidError);
  });

  it('parks in needs-config rather than errored, because it is a config fault', async () => {
    // Subclassing AppNeedsConfigError is what routes this to the actionable
    // state at every existing `instanceof` site. If the subclass relationship
    // is ever broken, the app lands in `errored` and the operator is told the
    // platform failed rather than that their manifest did.
    await fs.writeFile(path.join(appPath, 'drop.yaml'), INVALID_MANIFEST);
    platform = makePlatform(true);

    await expect(buildSpec(platform)).rejects.toBeInstanceOf(AppNeedsConfigError);
  });

  it('names the parse error, so the operator knows which line to fix', async () => {
    await fs.writeFile(path.join(appPath, 'drop.yaml'), INVALID_MANIFEST);
    platform = makePlatform(true);

    await expect(buildSpec(platform)).rejects.toThrow(/not_a_real_field/);
  });

  it('still starts an app that simply has no manifest at all', async () => {
    // `exists` is checked separately from `success` on purpose: no drop.yaml is
    // the zero-config default DROP is built around, not a configuration fault.
    platform = makePlatform(true);

    await expect(buildSpec(platform)).resolves.toBeDefined();
  });

  it('still starts an app whose manifest parses', async () => {
    await fs.writeFile(path.join(appPath, 'drop.yaml'), 'type: nodejs\n');
    platform = makePlatform(true);

    await expect(buildSpec(platform)).resolves.toBeDefined();
  });
});

describe('what a needs-config park tells the operator to do', () => {
  it('does not tell them to set a secret when no secret is the problem', () => {
    // The empty-list trap: `missingSecrets` is `[]` for a manifest park by
    // definition, so the secret wording renders as "set required secret(s): "
    // with nothing after the colon.
    const err = new AppManifestInvalidError('demo', "Unknown field 'not_a_real_field'");

    expect(needsConfigAction(err)).toBe("fix drop.yaml (Unknown field 'not_a_real_field')");
    expect(needsConfigAction(err)).not.toContain('secret');
  });

  it('still names the missing secrets for an ordinary preflight park', () => {
    const err = new AppNeedsConfigError('demo', ['JWT_SECRET', 'API_KEY']);

    expect(needsConfigAction(err)).toBe('set required secret(s): JWT_SECRET, API_KEY');
    expect(needsConfigDetail(err, 'demo')).toBe(
      "Application 'demo' needs configuration — set required secret(s): JWT_SECRET, API_KEY, then retry"
    );
  });
});
