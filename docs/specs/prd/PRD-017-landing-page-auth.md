# PRD-017: Landing Page & Dashboard Authentication

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-017 |
| Feature | Landing Page & Auth |
| Status | Not Started |
| Phase | 4 - Production Readiness |
| Priority | P0 |
| Created | 2026-03-19 |

---

## 1. Overview

### 1.1 Summary
Add a public landing page that introduces DROP before requiring authentication. The dashboard should be protected by default, with the landing page serving as the entry point for all users. Unauthenticated users see the landing page with a sign-in option; authenticated users go straight to the dashboard.

### 1.2 Goals
- [ ] Public landing page explaining what DROP is
- [ ] Sign-in flow from landing page to dashboard
- [ ] Auth enabled by default (not just in production)
- [ ] First-run setup: display generated admin credentials
- [ ] Clean transition between landing → login → dashboard

### 1.3 Non-Goals
- OAuth/SSO integration
- Self-service registration
- Password reset flow

---

## 2. Technical Design

### 2.1 User Flows

**First visit (auth enabled):**
```
/ (landing page) → Sign In → Login form → Dashboard
```

**Returning visit (token in localStorage):**
```
/ (landing page) → auto-redirect → Dashboard
```

**Auth disabled:**
```
/ (landing page) → Enter Dashboard → Dashboard
```

### 2.2 Components

1. **LandingPage** - Public page with DROP branding, features summary, sign-in CTA
2. **Updated App.tsx routing** - Landing at `/`, dashboard routes under `/dashboard/*`
3. **Auth status endpoint** - `GET /api/v1/auth/status` returns `{ enabled, authenticated }`
4. **Default auth enabled** - `enableApiAuth` defaults to `true`

### 2.3 Landing Page Content
- DROP logo and tagline
- 3-4 feature highlights (deploy from git, auto-detect, database, dashboard)
- "Sign In" button (when auth enabled) or "Open Dashboard" (when disabled)
- Clean, professional design matching dashboard dark/light theme

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify
- `src/dashboard/src/pages/LandingPage.tsx` - New landing page
- `src/dashboard/src/App.tsx` - Updated routing
- `src/api/routes/auth.ts` - Add `/auth/status` endpoint
- `src/core/platform.ts` - Default `enableApiAuth` to `true`

---
