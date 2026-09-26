/**
 * The agent-facing surface we PUBLISH must match the one we SHIP (#303).
 *
 * `llms.txt` is the file agents read to decide what DROP can do, and it lives
 * in drop-site, where nothing here can fail when it drifts. It did drift: three
 * separate model reviews concluded DROP lacked capabilities it had, because the
 * MCP tools and error codes were never written down.
 *
 * Same mechanism as src/core/detector/documented-samples.test.ts, for the same
 * reason (DROP-139 moved the site out of this tree): the lists below are a copy
 * of what drop-site publishes, and each is checked against the code in BOTH
 * directions. Adding a tool or a code without publishing it fails here, where
 * the change is being made; so does removing one that is still advertised.
 *
 * When one of these fails: update the list below AND the matching section of
 * drop-site `public/llms.txt` (dropkit.sh/llms.txt) in the same change.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildMcpServer } from './tools';
import { DEPLOY_ERROR_CODES } from './deploy-result';
import { ErrorCodes } from '../types';

const PUBLISHED_IN = 'drop-site public/llms.txt (dropkit.sh/llms.txt)';

/** MCP tools, as listed in llms.txt's tool section. */
const PUBLISHED_MCP_TOOLS = [
  'deploy_files',
  'deploy_from_git',
  'list_apps',
  'app_status',
  'verify_deployment',
  'app_logs',
  'get_deploy_logs',
  'restart_app',
  'rollback_app',
];

/** REST `error.code` values, as listed in llms.txt's errors section. */
const PUBLISHED_API_ERROR_CODES = [
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'CONFLICT',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'MUST_CHANGE_PASSWORD',
  'MFA_REQUIRED',
  'MFA_INVALID',
  'MFA_REPLAY',
];

/** Structured deploy result `error_code` values, as listed in llms.txt. */
const PUBLISHED_DEPLOY_ERROR_CODES = [
  'NO_STRATEGY',
  'MAX_BUILDS',
  'PREBUILD_FAILED',
  'INSTALL_FAILED',
  'BUILD_FAILED',
  'POSTBUILD_FAILED',
  'VALIDATE_FAILED',
  'PROCESS_EXITED',
  'CRASH_LOOPED',
  'OOM_KILLED',
  'READINESS_FAILED',
  'GUARDRAIL_TRIPPED',
  'QUOTA_EXCEEDED',
  'INSTALL_MISSING_DEP',
  'BUILD_TYPE_ERROR',
  'MIGRATION_FAILED',
  'UNKNOWN',
];

/**
 * Both directions, with a message that names what to change and where. A bare
 * `toEqual` diff would say the arrays differ without saying which file to fix.
 */
function expectPublished(what: string, shipped: string[], published: string[]): void {
  const unpublished = shipped.filter((x) => !published.includes(x));
  const stale = published.filter((x) => !shipped.includes(x));
  const problems: string[] = [];
  if (unpublished.length) {
    problems.push(
      `${what} shipped but not published: ${unpublished.join(', ')}. ` +
        `Add to the list in this file AND to ${PUBLISHED_IN}.`
    );
  }
  if (stale.length) {
    problems.push(
      `${what} published but no longer shipped: ${stale.join(', ')}. ` +
        `Remove from the list in this file AND from ${PUBLISHED_IN}.`
    );
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

describe('published agent surface matches the code (#303)', () => {
  it('every registered MCP tool is published, and nothing else is', () => {
    const registered: string[] = [];
    const spy = jest
      .spyOn(McpServer.prototype, 'registerTool')
      .mockImplementation(function (this: McpServer, name: string) {
        registered.push(name);
        return {} as ReturnType<McpServer['registerTool']>;
      } as McpServer['registerTool']);
    try {
      buildMcpServer(undefined);
    } finally {
      spy.mockRestore();
    }

    // Guard against the spy silently capturing nothing.
    expect(registered.length).toBeGreaterThan(0);
    expectPublished('MCP tool(s)', registered, PUBLISHED_MCP_TOOLS);
  });

  it('every REST ErrorCodes member is published, and nothing else is', () => {
    expectPublished('ErrorCodes member(s)', Object.values(ErrorCodes), PUBLISHED_API_ERROR_CODES);
  });

  it('every DeployErrorCode is published, and nothing else is', () => {
    expect(DEPLOY_ERROR_CODES.length).toBeGreaterThan(0);
    expectPublished('DeployErrorCode(s)', DEPLOY_ERROR_CODES, PUBLISHED_DEPLOY_ERROR_CODES);
  });

  it('names the file to fix when a list drifts', () => {
    expect(() => expectPublished('MCP tool(s)', ['a', 'new_tool'], ['a'])).toThrow(
      /new_tool.*drop-site public\/llms\.txt/
    );
    expect(() => expectPublished('MCP tool(s)', ['a'], ['a', 'gone'])).toThrow(/no longer shipped: gone/);
  });
});
