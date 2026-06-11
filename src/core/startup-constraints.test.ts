/**
 * Startup constraint tests (M2a).
 *
 * All Docker reachability probes are replaced with a controllable mock so
 * these tests pass on any OS regardless of whether Docker is installed.
 */

import {
  assertStartupConstraints,
  StartupConstraintError,
  IsolationMode,
} from './startup-constraints';

const dockerOk = jest.fn().mockResolvedValue(undefined);
const dockerFail = jest.fn().mockRejectedValue(
  new StartupConstraintError('Docker daemon is not reachable')
);

describe('assertStartupConstraints', () => {
  beforeEach(() => {
    dockerOk.mockClear();
    dockerFail.mockClear();
  });

  describe('happy paths', () => {
    it('none mode with no signup — always passes', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'none', allowSignup: false, enableApiAuth: true },
          { checkDocker: dockerOk }
        )
      ).resolves.toBeUndefined();
      expect(dockerOk).not.toHaveBeenCalled();
    });

    it('docker mode + docker reachable + no signup — passes', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: false, enableApiAuth: true },
          { checkDocker: dockerOk }
        )
      ).resolves.toBeUndefined();
      expect(dockerOk).toHaveBeenCalledTimes(1);
    });

    it('docker mode + signup + auth enabled — passes', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: true, enableApiAuth: true },
          { checkDocker: dockerOk }
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('fail-closed: Docker not reachable in docker mode', () => {
    it('throws StartupConstraintError when Docker is unreachable', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: false, enableApiAuth: true },
          { checkDocker: dockerFail }
        )
      ).rejects.toBeInstanceOf(StartupConstraintError);
    });

    it('error message describes the problem', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: false, enableApiAuth: true },
          { checkDocker: dockerFail }
        )
      ).rejects.toThrow('Docker daemon is not reachable');
    });

    it('does NOT probe Docker in none mode', async () => {
      await assertStartupConstraints(
        { isolation: 'none', allowSignup: false, enableApiAuth: false },
        { checkDocker: dockerFail }
      );
      expect(dockerFail).not.toHaveBeenCalled();
    });
  });

  describe('fail-closed: signup requires docker mode', () => {
    it('throws when allowSignup is true but isolation is none', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'none', allowSignup: true, enableApiAuth: true },
          { checkDocker: dockerOk }
        )
      ).rejects.toBeInstanceOf(StartupConstraintError);
    });

    it('error message names the violated constraint', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'none', allowSignup: true, enableApiAuth: true },
          { checkDocker: dockerOk }
        )
      ).rejects.toThrow(/allowSignup requires isolation: docker/);
    });
  });

  describe('fail-closed: signup requires auth', () => {
    it('throws when allowSignup is true but auth is disabled', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: true, enableApiAuth: false },
          { checkDocker: dockerOk }
        )
      ).rejects.toBeInstanceOf(StartupConstraintError);
    });

    it('error message names the violated constraint', async () => {
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: true, enableApiAuth: false },
          { checkDocker: dockerOk }
        )
      ).rejects.toThrow(/allowSignup requires API auth/);
    });
  });

  describe('check ordering', () => {
    it('docker check runs before signup checks', async () => {
      // docker + allowSignup + no-auth — docker probe fires first
      await expect(
        assertStartupConstraints(
          { isolation: 'docker', allowSignup: true, enableApiAuth: false },
          { checkDocker: dockerFail }
        )
      ).rejects.toThrow('Docker daemon is not reachable');
    });
  });

  describe('IsolationMode type', () => {
    it('only allows none or docker', () => {
      const modes: IsolationMode[] = ['none', 'docker'];
      expect(modes).toHaveLength(2);
    });
  });
});
