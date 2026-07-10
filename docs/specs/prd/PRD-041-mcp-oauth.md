# PRD-041: OAuth for the Hosted MCP Endpoint

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-041 |
| Feature | OAuth 2.1 for `/api/v1/mcp` (claude.ai connector support) |
| Status | Planned |
| Priority | P2 |
| Target | Post-v2.1 (when claude.ai connector support is wanted) |
| Depends On | PRD-040 (hosted MCP endpoint) |
| Created | 2026-07-10 |

---

## Overview

The hosted MCP endpoint (PRD-040) authenticates with API keys via an
`Authorization` header. Claude Code, Claude Desktop, and Cursor can send that
header; claude.ai's web "Connectors" UI historically cannot — it expects an
OAuth flow (a *Request headers* beta is rolling out, and a Caddy
header-injection shim works today; both interim paths are documented in
`docs/AGENT-DEPLOY.md`). This PRD makes DROP a first-class claude.ai
connector: OAuth 2.1 authorization-code + PKCE with dynamic client
registration, riding the existing dashboard login and JWT machinery, so a
user signs in and consents instead of pasting keys. The MCP spec mandates
OAuth 2.1 + PKCE for this flow.

## Changes

1. **Protected-resource metadata** — serve
   `/.well-known/oauth-protected-resource`, and return
   `401 WWW-Authenticate: Bearer resource_metadata=...` from `/api/v1/mcp`
   for unauthenticated requests, so MCP clients can discover the
   authorization server.
2. **Authorization server** — `/.well-known/oauth-authorization-server`
   metadata plus `/authorize` (code + PKCE, S256 only) and `/token`
   (code exchange + refresh) endpoints. Dynamic client registration
   (`/register`) per RFC 7591 — claude.ai registers itself.
3. **Consent** — `/authorize` requires a dashboard login session (existing
   auth), then renders a consent page naming the client and the scope
   ("deploy and manage your apps"); approval mints the code.
4. **Tokens** — short-lived access tokens (existing `jose` JWT
   infrastructure, `sub` = userId) accepted by `authMiddleware` on the MCP
   route exactly like API-key auth, so tool-level `canAccess` scoping is
   unchanged. Refresh tokens persisted server-side and revocable from the
   dashboard (list + revoke UI, mirroring API-key management).
5. **Docs** — replace the interim-workaround section in
   `docs/AGENT-DEPLOY.md` with the one-click connector flow.

## Non-Goals

- API-key header auth stays supported (Claude Code/Cursor path unchanged) —
  OAuth is additive, not a replacement.
- No third-party IdP integration (Google/GitHub SSO) — DROP's own users only.
- No scopes beyond the single "manage your apps" grant in v1.

## Notes

- Security review should cover: open-redirect on `redirect_uri` (exact-match
  against registered URIs), PKCE downgrade, token lifetime/rotation, and DCR
  abuse (rate-limit `/register`, cap registered clients).
- The interim Caddy shim documented in AGENT-DEPLOY.md should be explicitly
  deprecated in docs once this lands (the URL-as-credential pattern is the
  weakest link in the current story).
