# TASKS-017: Landing Page & Dashboard Authentication

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-017 |
| PRD | PRD-017 |
| Branch | `feature/DROP-017-landing-auth` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Auth Status Endpoint
- [ ] Add `GET /api/v1/auth/status` returning `{ enabled, authenticated }`
- [ ] Public endpoint (no auth required)

### 2. Default Auth Enabled
- [ ] Change `enableApiAuth` default to `true`
- [ ] Log generated admin credentials on first run

### 3. Landing Page Component
- [ ] Create `LandingPage.tsx` with DROP branding
- [ ] Feature highlights section
- [ ] Sign In / Open Dashboard CTA based on auth status
- [ ] Auto-redirect if already authenticated
- [ ] Dark/light theme support

### 4. Routing Updates
- [ ] Landing page at `/` (base dashboard route)
- [ ] Dashboard content routes remain as-is (apps, deploy, settings)
- [ ] Login page shown when auth required
- [ ] Redirect to apps after login

### 5. Build & Test
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
- [ ] Manual test: auth enabled flow
- [ ] Manual test: auth disabled flow
