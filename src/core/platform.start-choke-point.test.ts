/**
 * Pins the suspension start choke point: `runtime.start(` / `runtime.restart(`
 * may appear in platform.ts only inside `startInstance` / `restartInstance`,
 * which run `assertStartable` first. A new start path that calls the runtime
 * directly would skip the suspension check, and this is what fails when one is
 * added. (A helper that was correct in isolation while a caller bypassed it is
 * the recurring defect class here - see CLAUDE.md, "Security helpers have callers".)
 */
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.join(__dirname, 'platform.ts'), 'utf-8');
const LINES = SOURCE.split(/\r?\n/);

/**
 * A direct runtime call, whatever the receiver spelling (runtime.start(, runtime!.restart(,
 * runtime?.start( ...) and however it is wrapped: `this.runtime\n  .start(` counts too.
 */
const RUNTIME_CALL = /\bruntime[!?]?\s*\.\s*(start|restart)\s*\(/;
const RUNTIME_CALL_G = new RegExp(RUNTIME_CALL.source, 'g');

/** [first, last] 0-based line indices of a method body: its signature to the next line that is exactly `  }`. */
function bodyOf(signature: RegExp): [number, number] {
  const first = LINES.findIndex((l) => signature.test(l));
  if (first === -1) throw new Error(`method not found: ${signature}`);
  let last = first;
  while (last < LINES.length && LINES[last] !== '  }') last++;
  return [first, last];
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('platform.ts start choke point', () => {
  const allowed = [bodyOf(/^\s{2}private async startInstance\(/), bodyOf(/^\s{2}private async restartInstance\(/)];

  // Comment lines blanked, the rest joined so a call wrapped over several lines is still one match.
  const code = LINES.map((line) => (isComment(line) ? '' : line)).join('\n');
  const calls = [...code.matchAll(RUNTIME_CALL_G)].map((m) => {
    const i = code.slice(0, m.index).split('\n').length - 1;
    return { line: LINES[i], i };
  });

  it('finds the runtime calls it is meant to guard (the scan itself works)', () => {
    expect(calls.length).toBe(2);
  });

  it('calls runtime.start / runtime.restart only inside startInstance and restartInstance', () => {
    const stray = calls.filter(({ i }) => !allowed.some(([first, last]) => i >= first && i <= last));
    expect(stray.map(({ i, line }) => `${i + 1}: ${line.trim()}`)).toEqual([]);
  });

  it('runs assertStartable before the runtime call in both', () => {
    for (const [first, last] of allowed) {
      const body = LINES.slice(first, last + 1).join('\n');
      expect(body.indexOf('this.assertStartable(')).toBeGreaterThan(-1);
      expect(body.indexOf('this.assertStartable(')).toBeLessThan(body.search(RUNTIME_CALL));
    }
  });

  it('the scan sees a stray call (it would catch a new start path)', () => {
    expect(RUNTIME_CALL.test('      const status = await this.runtime!.start(spec);')).toBe(true);
    expect(RUNTIME_CALL.test('      await runtime.restart(name);')).toBe(true);
    expect(RUNTIME_CALL.test('      await this.runtime?.start(spec);')).toBe(true);
    expect(RUNTIME_CALL.test('      await this.startInstance(spec);')).toBe(false);
    expect(RUNTIME_CALL.test('      await this.runtime\n        .start(spec);')).toBe(true);
  });
});
