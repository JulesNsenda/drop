/**
 * Deploy error taxonomy.
 *
 * The point of these tests is that the code DISCRIMINATES. A closed union
 * whose deriver collapses to one value is the Gap A defect Step 1 removed — a
 * documented field reported as though it discriminated while being a constant.
 */

import { deriveErrorCode } from './deploy-error-code';

describe('deriveErrorCode', () => {
  describe('build phase', () => {
    it.each([
      ['pre-build', 'PREBUILD_FAILED'],
      ['environment', 'PREBUILD_FAILED'],
      ['install', 'INSTALL_FAILED'],
      ['build', 'BUILD_FAILED'],
      ['optimize', 'POSTBUILD_FAILED'],
      ['post-build', 'POSTBUILD_FAILED'],
      ['validate', 'VALIDATE_FAILED'],
    ] as const)('maps stage %s to %s', (stage, expected) => {
      expect(deriveErrorCode({ phase: 'build', stage })).toBe(expected);
    });

    it("lets the builder's own code win where the stage cannot distinguish", () => {
      // 'pre-build' covers BOTH a genuinely unbuildable app type and any other
      // pre-build failure. Those are very different answers for a caller: one
      // says "DROP cannot build this at all", the other says "something went
      // wrong before the build".
      expect(deriveErrorCode({ phase: 'build', stage: 'pre-build', builderCode: 'NO_STRATEGY' })).toBe(
        'NO_STRATEGY'
      );
      expect(deriveErrorCode({ phase: 'build', stage: 'pre-build', builderCode: 'MAX_BUILDS' })).toBe(
        'MAX_BUILDS'
      );
      expect(deriveErrorCode({ phase: 'build', stage: 'pre-build' })).toBe('PREBUILD_FAILED');
    });

    it('does NOT let EXCEPTION override the stage', () => {
      // 'the builder threw' is a mechanism, not a cause. The stage is the more
      // useful answer, so EXCEPTION deliberately falls through.
      expect(deriveErrorCode({ phase: 'build', stage: 'install', builderCode: 'EXCEPTION' })).toBe(
        'INSTALL_FAILED'
      );
    });

    it('falls back to UNKNOWN with no stage', () => {
      expect(deriveErrorCode({ phase: 'build' })).toBe('UNKNOWN');
    });
  });

  describe('boot phase', () => {
    it.each([
      ['process-exited', 'PROCESS_EXITED'],
      ['crash-looped', 'CRASH_LOOPED'],
    ] as const)('maps readiness verdict %s to %s', (reason, expected) => {
      expect(deriveErrorCode({ phase: 'boot', reason })).toBe(expected);
    });

    it('falls back to UNKNOWN with no reason', () => {
      expect(deriveErrorCode({ phase: 'boot' })).toBe('UNKNOWN');
    });

    it('does not leak a build stage into a boot verdict', () => {
      // Phase decides which signal is consulted. A stale stage on a boot
      // failure must not produce a build code.
      expect(deriveErrorCode({ phase: 'boot', stage: 'install' })).toBe('UNKNOWN');
    });
  });

  it('actually discriminates — distinct inputs give distinct codes', () => {
    // The assertion a collapsed deriver cannot satisfy. Each per-case test
    // above would still pass against a constant that happened to match.
    const codes = new Set([
      deriveErrorCode({ phase: 'build', stage: 'install' }),
      deriveErrorCode({ phase: 'build', stage: 'build' }),
      deriveErrorCode({ phase: 'build', stage: 'pre-build' }),
      deriveErrorCode({ phase: 'build', stage: 'validate' }),
      deriveErrorCode({ phase: 'build', stage: 'post-build' }),
      deriveErrorCode({ phase: 'build', stage: 'pre-build', builderCode: 'NO_STRATEGY' }),
      deriveErrorCode({ phase: 'boot', reason: 'process-exited' }),
      deriveErrorCode({ phase: 'boot', reason: 'crash-looped' }),
      deriveErrorCode({ phase: 'build' }),
    ]);

    expect(codes.size).toBe(9);
  });

  it('never throws, whatever it is handed', () => {
    // A classifier miss must not change the deploy verdict, so this has to be
    // total even against values TypeScript would have rejected.
    expect(() =>
      deriveErrorCode({ phase: 'build', stage: 'nonsense' as never, builderCode: 'x' })
    ).not.toThrow();
    expect(() => deriveErrorCode({ phase: 'nonsense' as never })).not.toThrow();
  });
});
