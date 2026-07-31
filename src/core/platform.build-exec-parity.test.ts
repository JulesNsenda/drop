/**
 * Tenant build commands must run inside the build container on BOTH build
 * paths, not just the fresh-deploy one.
 *
 * `install`, `build` and drop.yaml build hooks are tenant-authored strings.
 * Under docker isolation the builder is handed an `execCommand` that runs them
 * inside an ephemeral container (own user, CapDrop ALL, no docker socket).
 * With no `execCommand` the builder falls back to `executeCommand` — a plain
 * host `child_process` running as the platform user, who is in the `docker`
 * group on an isolation=docker box and therefore root-equivalent.
 *
 * `handleBuildApp` (fresh deploy) always passed one. `handleAppUpdate` — which
 * every upload-deploy and git redeploy of an EXISTING app goes through, i.e.
 * the common path — passed none.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DropPlatform, createPlatform } from './platform';

describe('build exec parity between the two build paths', () => {
  let tempDir: string;

  const makePlatform = (isolation: 'docker' | 'none'): DropPlatform => {
    const platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation,
    });
    // A docker-shaped runtime; `docker` is only ever handed to
    // createContainerExecCommand, which we never invoke here.
    (platform as any).runtime = { type: isolation === 'docker' ? 'docker' : 'pm2', docker: {} };
    return platform;
  };

  const execFor = (platform: DropPlatform) =>
    (platform as any).buildExecCommandFor('nodejs', 'my-app');

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-exec-parity-${Date.now()}-${Math.random()}`);
  });

  describe('buildExecCommandFor', () => {
    it('returns a container exec runner under docker isolation', () => {
      expect(typeof execFor(makePlatform('docker'))).toBe('function');
    });

    it('returns undefined under host isolation, where running on the host is the intent', () => {
      expect(execFor(makePlatform('none'))).toBeUndefined();
    });

    // The next two pin FAIL-CLOSED. Returning undefined here would be the
    // dangerous answer: it silently converts "configured for docker isolation
    // but no container runtime" into "run this tenant's install/build command
    // unconfined on the host". Throwing fails the build loudly, leaves the
    // previously-deployed version serving, and shows the operator a config
    // error instead of an invisible sandbox bypass.
    it('THROWS rather than falling back to the host when the runtime is not the container manager', () => {
      const platform = makePlatform('docker');
      (platform as any).runtime = { type: 'pm2' };
      expect(() => execFor(platform)).toThrow(/no container runtime/i);
    });

    it('THROWS rather than falling back to the host when there is no runtime at all', () => {
      const platform = makePlatform('docker');
      (platform as any).runtime = null;
      expect(() => execFor(platform)).toThrow(/no container runtime/i);
    });
  });

  describe('the invariant is compiler-enforced, not test-enforced', () => {
    // BuildContext.execCommand is REQUIRED (typed as the fn OR undefined), so
    // any builder.build call that omits it is a compile error — at every call
    // site, in every module. That is what actually prevents this regression
    // recurring. An earlier version of this file grepped platform.ts for the
    // property instead; that caught the named bug, but would have passed
    // vacuously the moment a build path moved into another file.
    //
    // This test fails loudly if the property is ever made optional again,
    // since that silently removes the compiler guarantee.
    it('BuildContext declares execCommand as required', () => {
      const types = fs.readFileSync(
        path.join(__dirname, 'builder', 'builder.types.ts'),
        'utf-8'
      );
      expect(types).toContain('execCommand: ExecCommandFn | undefined;');
      expect(types).not.toContain('execCommand?:');
    });
  });

  describe('the container check lives in one place', () => {
    it('createContainerExecCommand is invoked only inside the helper', () => {
      // A build path that re-implements the isolation check inline can drift
      // from this one — which is how handleAppUpdate ended up with no check.
      const source = fs.readFileSync(path.join(__dirname, 'platform.ts'), 'utf-8');
      // The import has no trailing paren, so only the invocation is counted.
      expect(source.split('createContainerExecCommand(').length - 1).toBe(1);
    });
  });
});
