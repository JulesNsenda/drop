/**
 * Structured deploy result — field discipline (SEC-6).
 *
 * A structured result INVERTS PRD-040's trust default. Under the old rule all
 * application output sat inside a fence; here every field is unfenced and
 * reads to a model as DROP's own words. So the security property under test is
 * not "is it fenced" but "can anything a tenant authored reach a field at
 * all".
 */

import {
  commandKindForStage,
  hintFor,
  nextActionsFor,
  DeployCommandKind,
} from './deploy-result';
import type { DeployErrorCode } from '../../managers/deploy-tracker';

const ALL_CODES: DeployErrorCode[] = [
  'NO_STRATEGY',
  'MAX_BUILDS',
  'PREBUILD_FAILED',
  'INSTALL_FAILED',
  'BUILD_FAILED',
  'POSTBUILD_FAILED',
  'VALIDATE_FAILED',
  'PROCESS_EXITED',
  'CRASH_LOOPED',
  'UNKNOWN',
];

describe('hint table', () => {
  it('has a literal hint for every error code', () => {
    for (const code of ALL_CODES) {
      expect(typeof hintFor(code)).toBe('string');
      expect(hintFor(code).length).toBeGreaterThan(0);
    }
  });

  it('returns the SAME string for the same code every time', () => {
    // The property that makes `hint` safe to render unfenced: it is a lookup,
    // not a template. Anything interpolated from a filename or an error
    // message would vary with the input.
    expect(hintFor('INSTALL_FAILED')).toBe(hintFor('INSTALL_FAILED'));
  });

  it('never contains interpolation syntax', () => {
    // Guards the specific regression: someone "improving" a hint by dropping
    // the failing file or command into it. The plan's own v1 schema example
    // showed interpolated prose, contradicting its own rule.
    for (const code of ALL_CODES) {
      const hint = hintFor(code);
      expect(hint).not.toMatch(/\$\{/);
      expect(hint).not.toMatch(/%s|\{\}/);
    }
  });

  it('falls back to the UNKNOWN hint for an unrecognised code', () => {
    expect(hintFor('SOMETHING_NEW' as DeployErrorCode)).toBe(hintFor('UNKNOWN'));
  });
});

describe('command kind', () => {
  it('is a closed enum, never a command line', () => {
    // `command` must never carry a tenant's drop.yaml `build:` override. The
    // only values it can take are these four.
    const allowed: DeployCommandKind[] = ['prebuild', 'install', 'build', 'validate'];
    const produced = (
      ['pre-build', 'environment', 'install', 'build', 'optimize', 'post-build', 'validate'] as const
    ).map(commandKindForStage);

    for (const kind of produced) {
      expect(allowed).toContain(kind);
    }
  });

  it('discriminates rather than collapsing to one value', () => {
    expect(new Set((['install', 'build', 'pre-build', 'validate'] as const).map(commandKindForStage)).size).toBe(4);
  });
});

describe('next actions', () => {
  const ALLOWED = ['app_logs', 'app_status', 'restart_app', 'list_apps'];

  it('only ever returns tool-name literals', () => {
    const all = [
      ...nextActionsFor('succeeded'),
      ...nextActionsFor('succeeded_unverified'),
      ...nextActionsFor('failed', 'build'),
      ...nextActionsFor('failed', 'boot'),
    ];
    for (const action of all) {
      expect(ALLOWED).toContain(action);
    }
  });

  it('points a BOOT failure at the runtime log, not the build log', () => {
    // The build succeeded, so the build log will not contain the crash.
    // Sending a caller there is the single most useless thing this field
    // could do.
    expect(nextActionsFor('failed', 'boot')).toContain('app_logs');
    expect(nextActionsFor('failed', 'boot')).toContain('restart_app');
  });

  it('suggests nothing after a clean success', () => {
    expect(nextActionsFor('succeeded')).toEqual([]);
  });

  it('suggests verifying an unverified success', () => {
    // The app is up but nothing confirmed it serves — the one case where a
    // "successful" deploy still warrants a look.
    expect(nextActionsFor('succeeded_unverified')).toContain('app_status');
  });
});
