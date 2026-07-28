/**
 * Per-app OAuth resources for tenant MCP servers (Step 11, PR 2).
 *
 * A deployed app that speaks MCP is its own protected resource, with its own
 * audience: `https://<app>.<domain><mcpPath>`. This module decides which
 * resource identifier a token request is allowed to name.
 *
 * THE RULE THIS EXISTS TO ENFORCE (SEC-1): audience equality stays EXACT, and
 * an audience is resolved to exactly one target. The rejected alternative was
 * relaxing `verifyOAuthAccessToken`'s `aud !== expected` into a lookup over a
 * set of acceptable audiences — that is a cross-resource token break in both
 * directions. A token minted for a tenant's `evil.example.com/mcp` would verify
 * at DROP's own `/api/v1/mcp` and receive the full tool set over every app its
 * user owns; and a DROP-scoped token would be replayable against a tenant.
 *
 * So: this resolver maps a canonical resource string to ONE target, the caller
 * mints a token whose audience is that target's identifier, and each
 * verification point independently states the audience IT expects. Nothing here
 * ever returns a set.
 */

import { canonicalizeUrl } from './metadata';

/** What a requested `resource` identifier refers to. */
export type OAuthResourceTarget =
  | { kind: 'drop' }
  | { kind: 'app'; appName: string; resource: string };

/** One MCP-speaking app, as the resolver needs to see it. */
export interface AppMcpResource {
  appName: string;
  /** The app's canonical MCP resource identifier. */
  resource: string;
}

/**
 * Canonical resource identifier for an app's MCP endpoint.
 *
 * `appBaseUrl` is DROP-computed (`computeAppUrl`) and `mcpPath` was allowlisted
 * by the drop.yaml parser — neither is raw tenant text at this point.
 */
export function getAppMcpResourceUrl(appBaseUrl: string, mcpPath: string): string {
  return canonicalizeUrl(`${canonicalizeUrl(appBaseUrl)}${mcpPath}`);
}

/**
 * Resolve a requested resource to exactly one target, or null to refuse.
 *
 * Matching is `===` on the canonicalized string, never `startsWith` and never a
 * host comparison: `https://app.example.com/mcp` and
 * `https://app.example.com/mcp-admin` are different resources, and a prefix
 * match would conflate them (the same defect the agent-scope grammar avoids by
 * comparing whole scopes).
 *
 * A caller that names no resource gets DROP's own — the pre-existing behaviour,
 * kept so an existing client that omits `resource` is unaffected.
 */
export function resolveOAuthResource(
  requested: string | undefined,
  dropResource: string,
  apps: AppMcpResource[]
): OAuthResourceTarget | null {
  if (requested === undefined) return { kind: 'drop' };

  let canonical: string;
  try {
    canonical = canonicalizeUrl(requested);
  } catch {
    return null;
  }

  if (canonical === dropResource) return { kind: 'drop' };

  // An app resource must match one entry exactly. Duplicate resource strings
  // would make the target ambiguous — refuse rather than pick one, since
  // picking would hand a token for whichever app happened to sort first.
  const matches = apps.filter(a => a.resource === canonical);
  if (matches.length !== 1) return null;

  return { kind: 'app', appName: matches[0].appName, resource: matches[0].resource };
}

/** The audience identifier a target's token must carry. */
export function audienceFor(target: OAuthResourceTarget, dropResource: string): string {
  return target.kind === 'drop' ? dropResource : target.resource;
}
