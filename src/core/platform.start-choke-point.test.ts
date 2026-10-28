/**
 * Pins the suspension start choke point across ALL of `src`.
 *
 * Starting an app on the runtime (`start`, and `restart` too: PM2's and Docker's
 * both start a STOPPED process) must go through `startInstance` /
 * `restartInstance` in platform.ts, which run `assertStartable` first. A new
 * start path that calls the runtime directly, from the platform or from a route
 * or the CLI, would skip the suspension check, and this is what fails when one
 * is added. (A helper that was correct in isolation while a caller bypassed it
 * is the recurring defect class here - see CLAUDE.md, "Security helpers have callers".)
 *
 * The scan is deliberately simple: for every non-test source file except the
 * adapters themselves it looks for `.start(` / `.restart(` (also `?.start(` and
 * `.start?.(`) on a receiver that IS the runtime: `runtime`, `this.runtime`,
 * `processManager`, a getter (`getAppRuntime(...)`, `getRuntime()`,
 * `getProcessManager()`), or a local name assigned from one of those.
 *
 * The adapters are exempted BY FILE, not by directory, so a new file next to
 * them is scanned like any other.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');
const PLATFORM = path.join(SRC, 'core', 'platform.ts');

/** The adapters implement start/restart; everything else must go through the platform. */
const ADAPTER_FILES = [
  path.join(SRC, 'managers', 'runtime', 'pm2-runtime.ts'),
  path.join(SRC, 'managers', 'runtime', 'container-manager.ts'),
  path.join(SRC, 'managers', 'process', 'process-manager.ts'),
];
const SKIPPED_DIRS = new Set(['node_modules', 'dashboard', '__testutils__', '__mocks__']);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...sourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !ADAPTER_FILES.includes(full)
    ) {
      found.push(full);
    }
  }
  return found;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** The file with comment lines blanked (line numbers kept), as one string, so a call wrapped over lines still matches. */
function codeOf(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (isComment(line) ? '' : line))
    .join('\n');
}

/** A call that returns the runtime or the process manager behind it, with any arguments. */
const GETTER = '(?:getAppRuntime|getRuntime|getProcessManager)\\([^)]*\\)';

/** Names that hold the runtime: `runtime`, `processManager`, plus any local assigned from `this.runtime` or a getter. */
function receiversIn(code: string): string[] {
  const alias = new RegExp(`\\b(?:const|let|var)\\s+(\\w+)\\s*(?::[^=\\n]+)?=\\s*(?:this\\.runtime|${GETTER})`, 'g');
  return ['runtime', 'processManager', ...[...code.matchAll(alias)].map((m) => m[1])];
}

/** Every direct start/restart on the runtime in `text`, as 0-based line numbers. */
function runtimeStartCalls(text: string): number[] {
  const code = codeOf(text);
  const receivers = receiversIn(code).join('|');
  const call = new RegExp(
    `(?:\\b(?:${receivers})\\s*[!?]?|${GETTER})\\s*\\.\\s*(?:start|restart)\\s*(?:\\?\\.)?\\s*\\(`,
    'g'
  );
  return [...code.matchAll(call)].map((m) => code.slice(0, m.index).split('\n').length - 1);
}

/** [first, last] 0-based line indices of a method body: its signature to the next line that is exactly `  }`. */
function bodyOf(lines: string[], signature: RegExp): [number, number] {
  const first = lines.findIndex((l) => signature.test(l));
  if (first === -1) throw new Error(`method not found: ${signature}`);
  const offset = lines.slice(first).findIndex((l) => l === '  }');
  if (offset === -1) throw new Error(`end of method not found: ${signature}`);
  return [first, first + offset];
}

describe('the suspension start choke point', () => {
  const platformLines = fs.readFileSync(PLATFORM, 'utf-8').split(/\r?\n/);
  const allowed = [
    bodyOf(platformLines, /^\s{2}private async startInstance\(/),
    bodyOf(platformLines, /^\s{2}private async restartInstance\(/),
  ];

  it('the scan sees the calls it is meant to catch (and ignores the rest)', () => {
    const hits = (code: string) => runtimeStartCalls(code).length;
    expect(hits('await this.runtime!.start(spec);')).toBe(1);
    expect(hits('await runtime.restart(name);')).toBe(1);
    expect(hits('await this.runtime?.start(spec);')).toBe(1);
    expect(hits('await this.runtime.start?.(spec);')).toBe(1);
    expect(hits('await this.runtime\n  .start(spec);')).toBe(1);
    expect(hits('await getAppRuntime().restart(name);')).toBe(1);
    expect(hits("await getAppRuntime('pm2').start(spec);")).toBe(1);
    expect(hits('await getRuntime().start(spec);')).toBe(1);
    expect(hits('await getProcessManager().restart(name);')).toBe(1);
    expect(hits('const pm = getProcessManager();\nawait pm.start(cfg);')).toBe(1);
    expect(hits('await this.processManager.start(cfg);')).toBe(1);
    expect(hits('const pm = getAppRuntime();\nawait pm.start(spec);')).toBe(1);
    expect(hits('const rt = this.runtime;\nawait rt.restart(name);')).toBe(1);
    expect(hits('await this.startInstance(spec);')).toBe(0);
    expect(hits('// runtime.start(spec) is guarded\n * runtime.restart(name)')).toBe(0);
    expect(hits('await container.start();')).toBe(0);
    expect(hits('await runtime.getStatus(name);')).toBe(0);
  });

  it('platform.ts calls runtime.start / runtime.restart only inside startInstance and restartInstance', () => {
    const text = platformLines.join('\n');
    const calls = runtimeStartCalls(text);
    // The two guarded calls exist (the scan is not silently matching nothing)...
    expect(calls.length).toBe(2);
    const stray = calls.filter((i) => !allowed.some(([first, last]) => i >= first && i <= last));
    expect(stray.map((i) => `${i + 1}: ${platformLines[i].trim()}`)).toEqual([]);
  });

  it('no other source file starts or restarts an app on the runtime', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === PLATFORM) continue;
      for (const i of runtimeStartCalls(fs.readFileSync(file, 'utf-8'))) {
        offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('startInstance and restartInstance stay tiny, and run assertStartable before the runtime call', () => {
    for (const [first, last] of allowed) {
      // A guard that grows logic around the call is a guard someone will route around.
      expect(last - first + 1).toBeLessThanOrEqual(5);
      const body = platformLines.slice(first, last + 1).join('\n');
      expect(body.indexOf('this.assertStartable(')).toBeGreaterThan(-1);
      expect(body.indexOf('this.assertStartable(')).toBeLessThan(body.search(/runtime[!?]?\s*\.\s*(start|restart)/));
    }
  });
});
