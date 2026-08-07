# PRD-049: Design-Implied Auth Affordances (Backlog)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-049 |
| Feature | SSO login, password reset, and API-key login mode — as implied by `Login.dc.html` |
| Status | **Backlog — needs product decision** (not scheduled) |
| Phase | Auth / Security |
| Priority | P3 |
| Target | TBD |
| Related | PRD-046 (auth redesign renders/omits these), PRD-041 (MCP OAuth — SSO overlap), PRD-012 (security), PRD-017 (auth) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

The `Login.dc.html` mockup shows three affordances the app does **not** implement:

1. A **Password / API-key** segmented toggle (log in with an API key instead of a password).
2. A **"Forgot?"** link (password reset).
3. **"⌥ Continue with SSO"** (single sign-on).

Per the redesign rule ("design-implied functionality we don't have → capture as a PRD, don't
silently build or fake it"), this document records them. It is deliberately a **backlog PRD**:
each item is a real product/security decision with open questions, not a settled requirement.
**PRD-046 must not fake these controls** — it renders them disabled/"coming soon" or omits them
until one is actually built here.

These three are grouped because they share a theme (login entry points) and none is on the
redesign's critical path. They can be split into separate PRDs when/if prioritized.

### 1.2 Goals

This PRD's only near-term goal is to **capture scope and open questions** so the redesign doesn't
either fake or drop them. Implementation goals per feature are provisional:

- **API-key login (provisional):** allow authenticating the dashboard session with an existing API
  key (DROP-042) instead of username/password.
- **Password reset (provisional):** a self-service "forgot password" flow.
- **SSO (provisional):** OAuth/OIDC-based single sign-on.

### 1.3 Non-Goals

- Committing to build any of these now.
- Designing the full mechanics before a prioritization decision (this PRD lists open questions, not
  a final design).

---

## 2. Per-feature notes & open questions

### 2.1 API-key login mode

- **What exists:** API keys already authenticate the **REST API** (`api-credentials.json`,
  `authMiddleware`). They are managed in Settings → API Keys (DROP-042, admin-only).
- **Open questions:**
  - Should a *browser session* be establishable from an API key, or are API keys strictly for
    programmatic/API access? (Mixing session + key auth has UX and security implications.)
  - If yes: does it mint a JWT session, or does the SPA operate in a key-bearer mode? Token
    storage? Expiry/rotation UX?
  - Role mapping: an API key has a role (readonly/user/admin) — does key-login inherit it?
- **Recommendation:** likely the lowest-value of the three for an interactive dashboard; consider
  omitting the toggle entirely rather than building it, unless there's a concrete user need.

### 2.2 Password reset ("Forgot?")

- **What exists:** nothing. PRD-017 explicitly listed a password-reset flow as a non-goal. Admins
  can reset *other* users' passwords via UsersPage; there is no self-service reset.
- **Open questions:**
  - **Email infrastructure.** Self-service reset normally needs email (reset tokens). DROP has no
    mail sender today — adding one is the real cost. Is an out-of-band/CLI reset acceptable instead
    (e.g. `drop user reset-password <username>` on the server, mirroring the MFA `drop mfa disable`
    recovery pattern)?
  - Token generation, expiry, single-use, rate-limiting, and audit-logging of resets.
  - First-run/admin bootstrap interaction.
- **Recommendation:** a **CLI/server-side reset** (no email) fits DROP's self-hosted model and is
  far cheaper than standing up mail; the web "Forgot?" link could point to docs describing it,
  rather than a full email flow. Decide before building.

### 2.3 SSO ("Continue with SSO")

- **What exists:** nothing. **Overlaps PRD-041 (MCP OAuth)**, which has a ready-to-build OAuth
  design currently **on hold**. Dashboard SSO and MCP OAuth should share one OAuth/OIDC foundation
  rather than build two auth stacks.
- **Open questions:**
  - Which providers (generic OIDC? GitHub? Google? self-hosted IdP)? Self-hosters vary widely.
  - Provider config surface (env vars / `drop.yaml` / settings UI) and secret handling.
  - Account linking: map SSO identities to existing local users vs. auto-provision; role
    assignment; interaction with MFA and the admin bootstrap.
  - Callback URLs under the Caddy/HTTPS routing; single-instance self-hosted assumptions.
- **Recommendation:** treat as a genuine feature project, explicitly coordinated with PRD-041; do
  not start from the login mockup. Highest effort of the three.

---

## 3. Implementation Plan

Deferred. When any item is prioritized, promote it to its own scheduled PRD (or expand this one)
with a full design. At that point, PRD-046's login screen wires the now-real control.

### 3.1 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`),
  `Login.dc.html` (the affordances shown).

---

## 4. Risks & Open Questions

- **Faking controls.** The main near-term risk is PRD-046 shipping controls that look functional
  but aren't. Guard: PRD-046 §2.4 requires disabled/"coming soon"/omitted, never fake.
- **Two auth stacks.** Building dashboard SSO separately from PRD-041 MCP OAuth would duplicate a
  security-critical surface. Coordinate.
- **Email dependency.** Password reset's real cost is mail infrastructure; the CLI-reset
  alternative avoids it and suits self-hosting — decide before committing.
- **Security review required.** All three touch authentication; none should ship without a
  security pass (PRD-012).
