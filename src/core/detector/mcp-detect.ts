/**
 * MCP endpoint detection (Step 11).
 *
 * An MCP server is NOT an app type: it is an ordinary nodejs/python app that
 * happens to speak MCP over Streamable HTTP on a path. So this resolves an
 * ATTRIBUTE alongside `type`, never a new member of the type union and never a
 * detector in the priority chain — an MCP app must keep the build strategy its
 * real type selects.
 *
 * Detection changes no routing and no auth. DROP's whole-host `reverse_proxy`
 * already carries `<app>.<domain><path>` to the app, so all a label does is let
 * the endpoint be surfaced to a human or an agent. That is why inferring
 * wrongly (an MCP *client* that merely depends on the SDK) is cosmetic rather
 * than dangerous.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { AppMcpConfig } from './drop-yaml-parser';

/** Endpoint path when nothing says otherwise. */
export const DEFAULT_MCP_PATH = '/mcp';

/** A resolved MCP endpoint for an app. */
export interface McpEndpoint {
  path: string;
  /** Only 'none' exists today — DROP guards nothing. See AppMcpConfig.auth. */
  auth: 'none';
  /** Whether this came from drop.yaml or was inferred from a manifest. */
  source: 'declared' | 'inferred';
}

/** The Node SDK package that makes an app an MCP server. */
const NODE_SDK = '@modelcontextprotocol/sdk';

/**
 * A requirements.txt line declaring the Python `mcp` package.
 *
 * Deliberately strict — anchored, and matching only the exact distribution name
 * with optional extras. `mcpx`, `fastmcp` and `mcp-foo` do NOT match. A missed
 * label is cosmetic; a wrong one is noise in a security-adjacent surface.
 */
const PY_MCP_LINE = /^\s*mcp(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>|<|$)/i;

export interface McpDetectInput {
  /** The `mcp:` block from drop.yaml, if the app declared one. */
  declared?: AppMcpConfig;
  /** Parsed package.json, if the app has one. */
  packageJson?: { dependencies?: unknown; devDependencies?: unknown } | null;
  /** Raw requirements.txt contents, if the app has one. */
  requirementsTxt?: string | null;
}

function hasNodeSdk(pkg: McpDetectInput['packageJson']): boolean {
  if (!pkg || typeof pkg !== 'object') return false;
  for (const field of [pkg.dependencies, pkg.devDependencies]) {
    if (field && typeof field === 'object' && !Array.isArray(field)) {
      const names = Object.keys(field as Record<string, unknown>);
      // Exact name or a subpath entry (`@modelcontextprotocol/sdk/server`).
      if (names.some(n => n === NODE_SDK || n.startsWith(`${NODE_SDK}/`))) return true;
    }
  }
  return false;
}

function hasPythonMcp(requirements: string | null | undefined): boolean {
  if (!requirements) return false;
  return requirements
    .split(/\r?\n/)
    .some(line => !line.trimStart().startsWith('#') && PY_MCP_LINE.test(line));
}

/**
 * Resolve an app's MCP endpoint, or undefined when it is not an MCP server.
 *
 * An explicit `mcp:` block ALWAYS wins, including over a manifest that says
 * otherwise: the tenant declaring the shape is a stronger signal than a
 * dependency, and it is the only way to override the default path.
 */
export function detectMcp(input: McpDetectInput): McpEndpoint | undefined {
  if (input.declared) {
    return {
      path: input.declared.path ?? DEFAULT_MCP_PATH,
      // The parser rejects every other value, so this cannot silently downgrade
      // a stronger setting to 'none'.
      auth: 'none',
      source: 'declared',
    };
  }

  if (hasNodeSdk(input.packageJson) || hasPythonMcp(input.requirementsTxt)) {
    return { path: DEFAULT_MCP_PATH, auth: 'none', source: 'inferred' };
  }

  return undefined;
}

/**
 * Read the manifests `detectMcp` reasons over. I/O only — kept separate so the
 * decision itself stays pure and testable without a filesystem.
 *
 * Every read is best-effort: a missing or malformed manifest means "no signal",
 * never a failed deploy. This runs on the build path, and an app must not fail
 * to deploy because its package.json could not be parsed for a cosmetic label.
 */
export async function readMcpInputs(
  appPath: string,
  declared?: AppMcpConfig
): Promise<McpDetectInput> {
  let packageJson: McpDetectInput['packageJson'] = null;
  let requirementsTxt: string | null = null;

  try {
    const raw = await fs.readFile(path.join(appPath, 'package.json'), 'utf-8');
    packageJson = JSON.parse(raw);
  } catch {
    packageJson = null;
  }

  try {
    requirementsTxt = await fs.readFile(path.join(appPath, 'requirements.txt'), 'utf-8');
  } catch {
    requirementsTxt = null;
  }

  return { declared, packageJson, requirementsTxt };
}
