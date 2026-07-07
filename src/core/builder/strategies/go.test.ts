/**
 * Go build strategy — binary-name sanitization (P1-8).
 *
 * The binary name is interpolated into a shell `go build -o <name> .` command,
 * so a crafted app/folder name must not be able to inject shell metacharacters
 * or a leading-dash argument.
 */

import { GoBuildStrategy } from './go';
import { BuildContext } from '../builder.types';

describe('GoBuildStrategy binary-name sanitization (P1-8)', () => {
  const strategy = new GoBuildStrategy();

  const ctx = (appName: string, buildCommand?: string): BuildContext =>
    ({
      appName,
      appPath: '/tmp/app',
      appType: 'go',
      framework: null,
      config: buildCommand ? { buildCommand } : {},
      env: {},
      workDir: '/tmp/work',
    }) as unknown as BuildContext;

  // The -o output token (between `-o ` and ` .`); may carry a `.exe` suffix on
  // Windows, but the name itself must be a safe token.
  const outputToken = (cmd: string | null): string => cmd!.split('-o ')[1].split(' ')[0];
  const SAFE_TOKEN = /^[a-zA-Z0-9_-]+(\.exe)?$/;

  it('reduces the -o binary name to a safe token (no shell metacharacters)', () => {
    const cmd = strategy.getBuildCommand(ctx('evil; rm -rf /'));
    expect(outputToken(cmd)).toMatch(SAFE_TOKEN);
    expect(cmd).not.toContain(';');
    expect(cmd).not.toContain('rm -rf');
  });

  it('does not let the binary name start with a dash', () => {
    const cmd = strategy.getBuildCommand(ctx('--output=/etc/passwd'));
    const token = outputToken(cmd);
    expect(token.startsWith('-')).toBe(false);
    expect(token).toMatch(SAFE_TOKEN);
  });

  it('passes an explicit buildCommand through unchanged', () => {
    const cmd = strategy.getBuildCommand(ctx('app', 'go build ./cmd/server'));
    expect(cmd).toBe('go build ./cmd/server');
  });
});
