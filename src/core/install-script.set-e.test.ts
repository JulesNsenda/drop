/**
 * No shell function may END on a bare `<test> && <command>`.
 *
 * Under `set -e`, a function whose last command is `[[ … ]] && cmd` returns 1
 * whenever the test is false. The caller then aborts the script, with no error
 * message. `ensure_docker` ended on `[[ "$USERNS_REMAP" == "1" ]] &&
 * ensure_userns_remap`, so every docker-isolation `--bootstrap` (and every
 * `--provision`, once the box's copy was current) died right after the image
 * pre-pull. Production escaped it only because its provisioning copy was stale
 * (#277).
 *
 * shellcheck does not flag this, so the rule is checked here, textually.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

const SCRIPTS = [
  'install.sh',
  ...fs
    .readdirSync(path.join(ROOT, 'scripts', 'deploy'))
    .filter(f => f.endsWith('.sh'))
    .map(f => path.join('scripts', 'deploy', f)),
];

/** Each top-level `name() {` … `}` function's last non-blank, non-comment line. */
function lastStatements(script: string): Array<{ fn: string; last: string }> {
  const out: Array<{ fn: string; last: string }> = [];
  let fn: string | null = null;
  let last = '';
  for (const line of script.split(/\r?\n/)) {
    const open = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{\s*$/);
    if (open) {
      fn = open[1];
      last = '';
      continue;
    }
    if (fn && /^\}\s*$/.test(line)) {
      out.push({ fn, last });
      fn = null;
      continue;
    }
    if (fn && !/^\s*(#|$)/.test(line)) last = line.trim();
  }
  return out;
}

const BARE_TEST_AND = /^(\[\[.*\]\]|\[ .* \]|test\s.*)\s*&&/;

describe('shell functions never end on a bare test && command', () => {
  it('finds the functions it checks', () => {
    const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf-8');
    expect(lastStatements(install).map(s => s.fn)).toContain('ensure_docker');
  });

  it('flags the shape that aborted --bootstrap', () => {
    const sample = 'f() {\n  echo hi\n  [[ "$X" == "1" ]] && g\n}\n';
    expect(lastStatements(sample).filter(s => BARE_TEST_AND.test(s.last))).toHaveLength(1);
  });

  it.each(SCRIPTS)('%s', rel => {
    const script = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const offenders = lastStatements(script)
      .filter(s => BARE_TEST_AND.test(s.last))
      .map(s => `${s.fn}: ${s.last}`);
    expect(offenders).toEqual([]);
  });
});
