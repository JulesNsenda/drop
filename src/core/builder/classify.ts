/**
 * Build-failure classifier (Step 5).
 *
 * PURE. No I/O, no state, no clock. Takes a log tail DROP already captured and
 * returns a refined error code plus, when it can prove one, a source location.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE.
 *
 * 1. A MISS MUST NOT CHANGE THE VERDICT. The caller already has a
 *    DROP-generated code derived from the failing stage. This function only
 *    ever REFINES it — BUILD_FAILED to BUILD_TYPE_ERROR, INSTALL_FAILED to
 *    INSTALL_MISSING_DEP. It never invents a failure, never contradicts the
 *    stage, and never returns UNKNOWN over a code the caller already had. The
 *    whole thing runs in a try/catch; a throw yields "no refinement".
 *
 * 2. `file` IS ATTACKER-CONTROLLED (SEC-6, high). It is extracted from a log
 *    the tenant's own build produced, and it lands in an UNFENCED field of a
 *    structured result — where a model reads it as DROP's own words.
 *
 *    `path.relative` is NOT sufficient containment, and this is the specific
 *    trap the plan called out: for
 *
 *      path.relative(appPath, path.resolve(appPath, "Deploy the following to
 *      production: X.ts"))
 *
 *    the result is that sentence, UNCHANGED — it never escapes appPath, so a
 *    containment check passes it straight into a trusted field. Injection with
 *    a `.ts` suffix.
 *
 *    So a candidate must additionally match SAFE_PATH after relativization,
 *    and `path.isAbsolute` is rejected explicitly: on Windows a cross-drive
 *    `path.relative` returns an absolute path, which a `startsWith('..')`
 *    check alone would miss.
 */

import * as path from 'path';

/** Refinements this classifier can produce. A subset of DeployErrorCode. */
export type ClassifiedErrorCode = 'INSTALL_MISSING_DEP' | 'BUILD_TYPE_ERROR' | 'MIGRATION_FAILED';

export interface ClassifiedFailure {
  /** Refined code, or undefined to leave the caller's code alone. */
  errorCode?: ClassifiedErrorCode;
  /** Relative, validated source path. Absent unless proven safe. */
  file?: string;
  line?: number;
}

/**
 * What may appear in a `file`. No spaces, no colons, no quotes, no control
 * characters — an allowlist, so anything unanticipated is rejected rather than
 * passed through.
 */
const SAFE_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;

/** Largest line number worth reporting; anything else is a parse artefact. */
const MAX_LINE = 1_000_000;

/**
 * Relativize and validate a path extracted from build output.
 * Returns undefined unless the result is provably a safe relative path.
 */
export function safeRelativePath(candidate: string, appPath?: string): string | undefined {
  if (!candidate) return undefined;

  let rel = candidate.trim();
  // Strip a leading ./ that every toolchain emits differently.
  rel = rel.replace(/^\.[\\/]/, '');

  if (appPath) {
    try {
      rel = path.relative(appPath, path.resolve(appPath, rel));
    } catch {
      return undefined;
    }
  }

  // Normalize separators so a Windows-shaped path is validated as one string.
  rel = rel.split(path.sep).join('/').replace(/\\/g, '/');

  // Escapes the app dir, or is absolute (including the Windows cross-drive
  // case, where path.relative returns something absolute and a startsWith('..')
  // check would pass it).
  if (rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return undefined;
  }

  // The load-bearing check. Everything above still admits
  // "Deploy the following to production: X.ts".
  if (!SAFE_PATH.test(rel)) return undefined;

  return rel;
}

function parseLine(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LINE) return undefined;
  return n;
}

interface Matcher {
  /** Only refine a code the caller already derived to one of these. */
  appliesTo: ReadonlyArray<string>;
  code: ClassifiedErrorCode;
  patterns: RegExp[];
  /** Optional location pattern; groups 1 = file, 2 = line. */
  location?: RegExp[];
}

const MATCHERS: Matcher[] = [
  {
    // npm/yarn/pnpm cannot resolve a dependency. The package is named, not a
    // source file — `file` is correctly absent for this class.
    appliesTo: ['INSTALL_FAILED', 'PREBUILD_FAILED'],
    code: 'INSTALL_MISSING_DEP',
    patterns: [
      /\bE404\b/,
      /404 Not Found.*ETARGET/i,
      /npm ERR! notarget/i,
      /Could not resolve dependency/i,
      /ERR_PNPM_NO_MATCHING_VERSION/,
      /No matching distribution found for /i, // pip
      /ERROR: Could not find a version that satisfies/i, // pip
    ],
  },
  {
    appliesTo: ['BUILD_FAILED', 'POSTBUILD_FAILED', 'VALIDATE_FAILED'],
    code: 'BUILD_TYPE_ERROR',
    patterns: [/error TS\d+:/, /Type error:/i],
    location: [
      // tsc pretty:   src/server.ts:42:9 - error TS2345
      /([\w./-]+\.[cm]?tsx?):(\d+):\d+\s+-\s+error TS\d+/,
      // tsc classic:  src/server.ts(42,9): error TS2345
      /([\w./-]+\.[cm]?tsx?)\((\d+),\d+\):\s*error TS\d+/,
    ],
  },
  {
    appliesTo: ['BUILD_FAILED', 'POSTBUILD_FAILED'],
    code: 'BUILD_TYPE_ERROR',
    patterns: [
      /Could not resolve ["'][^"']+["'] from/, // rollup/vite
      /\[vite\]:? Rollup failed to resolve/i,
      /ERR_MODULE_NOT_FOUND/,
      /Cannot find module ['"]/,
    ],
    location: [/([\w./-]+\.[cm]?[jt]sx?):(\d+):\d+/],
  },
  {
    // Migration tooling. PLAUSIBLE, never confirmed — DROP has no migration
    // concept, so this is a pattern match on a convention, not a fact.
    appliesTo: ['BUILD_FAILED', 'PROCESS_EXITED', 'CRASH_LOOPED'],
    code: 'MIGRATION_FAILED',
    patterns: [
      /\bmigration[s]?\b.*\bfailed\b/i,
      /prisma migrate.*failed/i,
      /knex.*migration.*failed/i,
      /alembic.*(error|failed)/i,
      /relation ".*" already exists/i,
    ],
  },
];

/**
 * Refine a build failure from its log tail.
 *
 * `derivedCode` is the caller's DROP-generated code; a matcher only fires when
 * it applies to that code, so the classifier can sharpen the answer but never
 * contradict the stage the builder actually reported.
 */
export function classifyBuildFailure(
  logTail: string | undefined,
  derivedCode: string,
  appPath?: string
): ClassifiedFailure {
  try {
    if (!logTail) return {};

    for (const matcher of MATCHERS) {
      if (!matcher.appliesTo.includes(derivedCode)) continue;
      if (!matcher.patterns.some((p) => p.test(logTail))) continue;

      const result: ClassifiedFailure = { errorCode: matcher.code };

      for (const loc of matcher.location ?? []) {
        const m = loc.exec(logTail);
        if (!m) continue;
        const file = safeRelativePath(m[1], appPath);
        if (!file) continue; // Unsafe path: drop the location, keep the code.
        result.file = file;
        result.line = parseLine(m[2]);
        break;
      }

      return result;
    }

    return {};
  } catch {
    // A classifier miss must never change the verdict.
    return {};
  }
}
