/**
 * MCP endpoint detection (Step 11).
 *
 * The property under test is PRECEDENCE and CONSERVATISM: an explicit
 * declaration always wins, inference is strict enough not to label every app
 * that merely mentions MCP, and nothing here ever produces an auth value other
 * than 'none' (DROP guards nothing until PR 2).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { detectMcp, readMcpInputs, DEFAULT_MCP_PATH } from './mcp-detect';

describe('detectMcp', () => {
  describe('declaration wins', () => {
    it('uses the declared path', () => {
      const result = detectMcp({ declared: { path: '/tools' } });
      expect(result).toEqual({ path: '/tools', auth: 'none', source: 'declared' });
    });

    it('defaults the path when the block is present but empty', () => {
      expect(detectMcp({ declared: {} })?.path).toBe(DEFAULT_MCP_PATH);
    });

    it('beats a manifest that would infer the default path', () => {
      // The tenant saying "/rpc" is a stronger signal than a dependency, and
      // declaring a path is the ONLY way to override the default.
      const result = detectMcp({
        declared: { path: '/rpc' },
        packageJson: { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } },
      });
      expect(result?.path).toBe('/rpc');
      expect(result?.source).toBe('declared');
    });
  });

  describe('inference from a Node manifest', () => {
    it('detects the SDK in dependencies', () => {
      const result = detectMcp({
        packageJson: { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } },
      });
      expect(result).toEqual({ path: DEFAULT_MCP_PATH, auth: 'none', source: 'inferred' });
    });

    it('detects the SDK in devDependencies', () => {
      expect(
        detectMcp({ packageJson: { devDependencies: { '@modelcontextprotocol/sdk': '1.2.3' } } })
      ).toBeDefined();
    });

    it('detects a subpath entry', () => {
      expect(
        detectMcp({ packageJson: { dependencies: { '@modelcontextprotocol/sdk/server': '1.0.0' } } })
      ).toBeDefined();
    });

    it('does not detect an unrelated dependency', () => {
      expect(detectMcp({ packageJson: { dependencies: { express: '^4' } } })).toBeUndefined();
    });

    it('survives a malformed manifest shape', () => {
      // package.json is tenant-authored; `dependencies: "nope"` must not throw
      // on the build path.
      expect(
        detectMcp({ packageJson: { dependencies: 'nope' } as never })
      ).toBeUndefined();
    });
  });

  describe('inference from requirements.txt', () => {
    it.each([['mcp'], ['mcp==1.2.0'], ['mcp>=1.0'], ['mcp[cli]==1.0'], ['  mcp ~= 1.0']])(
      'detects %s',
      line => {
        expect(detectMcp({ requirementsTxt: `flask==3.0\n${line}\n` })).toBeDefined();
      }
    );

    it.each([['mcpx==1.0'], ['fastmcp==1.0'], ['mcp-server-git==1.0'], ['# mcp==1.0']])(
      'does NOT detect %s',
      line => {
        // Strictness is deliberate: a missed label is cosmetic, a wrong one is
        // noise on a security-adjacent surface.
        expect(detectMcp({ requirementsTxt: line })).toBeUndefined();
      }
    );
  });

  it('returns undefined when there is no signal at all', () => {
    expect(detectMcp({})).toBeUndefined();
    expect(detectMcp({ packageJson: null, requirementsTxt: null })).toBeUndefined();
  });
});

describe('readMcpInputs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mcp-detect-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('reads both manifests when present', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '1.0.0' } })
    );
    await fs.writeFile(path.join(dir, 'requirements.txt'), 'mcp==1.0\n');

    const inputs = await readMcpInputs(dir);

    expect(detectMcp(inputs)).toBeDefined();
  });

  it('treats a malformed package.json as no signal rather than throwing', async () => {
    // An app must not fail to DEPLOY because a cosmetic label could not be
    // computed — every read here is best-effort.
    await fs.writeFile(path.join(dir, 'package.json'), '{ not json');

    const inputs = await readMcpInputs(dir);

    expect(inputs.packageJson).toBeNull();
    expect(detectMcp(inputs)).toBeUndefined();
  });

  it('carries the declaration through untouched', async () => {
    const inputs = await readMcpInputs(dir, { path: '/mcp-x' });
    expect(detectMcp(inputs)?.path).toBe('/mcp-x');
  });
});
