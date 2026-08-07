# PRD-048: Per-App Metrics (Metrics Tab)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-048 |
| Feature | Per-app resource + traffic metrics, surfaced as the app-detail **Metrics** tab |
| Status | Not Started |
| Phase | Observability / Frontend + Backend |
| Priority | P2 |
| Target | v2.1+ (Phase 1) / v2.2+ (Phase 2) |
| Depends On | PRD-047 (app-detail tabs), PRD-004 (process manager) |
| Related | PRD-015 (monitoring), PRD-008 (reverse proxy — traffic source), PRD-036 (resource limits) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

`Dashboard.dc.html` shows a **Metrics** tab on the app-detail panel with bar-charts for **CPU**,
**Memory**, **Requests/sec**, and **p95 latency**, and the overview strip shows an **Avg CPU** and
a **Requests/min** stat card. Today the dashboard surfaces **no** per-app resource or traffic
metrics anywhere.

This is genuinely new functionality (hence a PRD, per the redesign rule). Crucially it splits into
two very different halves:

- **Phase 1 — surface data we already have.** PM2 already reports per-process **CPU**, **memory**,
  and **uptime** (`src/managers/process/pm2-client.ts` → `monit.cpu`, `monit.memory`,
  `pm_uptime`, aggregated across instances; there is a `ProcessMetrics` type). Exposing these is a
  read + a chart — no new collection infrastructure.
- **Phase 2 — instrument what we don't measure.** **Requests/sec** and **p95 latency** require
  request-level instrumentation that does not exist. That needs a metrics source (Caddy access
  logs / an app-level middleware / a proxy counter) and time-series storage. This is a real
  backend project, not a UI change.

Shipping Phase 1 first delivers a real, honest Metrics tab; Phase 2 lands when instrumentation
exists. **No fabricated numbers** in either the tab or the overview cards.

### 1.2 Goals

**Phase 1 (resource metrics — mostly existing data):**
- [ ] API endpoint(s) exposing per-app CPU / memory / uptime from PM2 (extend the existing
      process-status path rather than inventing a parallel collector).
- [ ] Metrics tab renders current CPU %, memory (MB), and uptime, refreshed on an interval
      consistent with other live views (e.g. the health/log cadence).
- [ ] Overview `StatCard`s (Avg CPU, Apps online) sourced from the same real data.
- [ ] Graceful states: stopped app (no live process) → "no metrics while stopped"; multi-instance
      → aggregated (matching `pm2-client`'s aggregation).

**Phase 2 (traffic metrics — new instrumentation):**
- [ ] Decide + implement a request metrics source (see §2.2) for per-app requests/sec and p95
      latency.
- [ ] Lightweight time-series retention (rolling window) sufficient for the tab's charts.
- [ ] Overview "Requests/min" card + the requests/latency charts, gated on real data.

### 1.3 Non-Goals

- A full monitoring/alerting stack (that is PRD-015's territory; this is per-app in-dashboard
  charts only).
- Long-term metrics retention / external TSDB / Prometheus export (possible future PRD).
- Historical CPU/memory graphs beyond a short rolling window in Phase 1 (Phase 1 can be
  near-real-time / short-history; deeper history is Phase 2+).

---

## 2. Technical Design

### 2.1 Phase 1 — resource metrics from PM2

`pm2-client.ts` already produces, per process (aggregated across instances):

- `cpu` (from `monit.cpu`)
- `memory` (from `monit.memory`)
- `uptime` (`Date.now() - pm_uptime`)

Design:
- Extend the process/status API to return these for a single app (the app-status route likely
  already has access to the describe/monit data — confirm and reuse rather than add a collector).
- The Metrics tab polls that endpoint on an interval and renders CPU %, memory, uptime, plus a
  short client-side rolling history for a sparkline/bar-chart look matching the mockup.
- Aggregation and stopped-state handling mirror `pm2-client` semantics.

This phase adds **no** new storage and **no** new background collection — it reads what PM2 already
computes.

### 2.2 Phase 2 — request metrics (new; open design)

Requests/sec and p95 latency need a source. Options (decision deferred — see §4):

1. **Caddy access logs.** Caddy already fronts routing/HTTPS (PRD-008). Parse/stream per-host
   access logs for request counts + latency. Pro: no app cooperation, covers all runtimes. Con:
   log parsing + a rolling aggregator; latency granularity depends on Caddy log fields.
2. **Proxy-level counters.** If a DROP-owned proxy layer exists in the request path, increment
   counters there. Pro: structured. Con: only if such a layer exists.
3. **App middleware.** Inject a metrics middleware. Con: runtime-specific, invasive, doesn't fit
   the zero-config philosophy — likely rejected.

Whichever is chosen needs a small rolling time-series (in-memory ring buffer or a file-backed
window; consistent with DROP's file-based state model) — not a full TSDB.

### 2.3 Frontend

- New `MetricsTab` under the app-detail tabs (PRD-047). Uses PRD-045 primitives + a small chart
  component (self-contained; no external chart CDN — CSP blocks external scripts, so any chart lib
  must be bundled, or draw simple bars with divs/SVG as the mockup does).
- Overview `StatCard`s consume the same endpoints.

### 2.4 Honesty constraint

Until Phase 2 ships, the requests/sec and p95 charts + the "Requests/min" overview card must be
**absent or clearly labeled unavailable** — never populated with placeholder/fake values. This is
a hard requirement echoed from PRD-047 §2.3.

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

**Phase 1:**
- `src/api/routes/` — extend the app-status route (or add a metrics route) to expose CPU/mem/uptime.
- `src/managers/process/` — reuse/expose the existing `ProcessMetrics`; add a per-app getter if
  one isn't already exposed.
- `src/dashboard/src/components/MetricsTab.tsx` (or `pages/AppDetailPage.tsx` tab) — the tab UI.
- `src/dashboard/src/pages/AppsPage.tsx` — wire the real Avg CPU / Apps-online stat cards.

**Phase 2 (design first, then):**
- A request-metrics collector (source per §2.2) + rolling store.
- API route for per-app request rate + latency percentiles.
- `MetricsTab` + overview extended with requests/latency once data is real.

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`),
  `Dashboard.dc.html` (Metrics tab + overview cards).
- Existing `src/managers/process/pm2-client.ts` (`ProcessMetrics`, `monit.*`).

---

## 4. Risks & Open Questions

- **Phase 2 source is unresolved** — Caddy-log parsing vs. proxy counters vs. app middleware. This
  is the main open decision; it determines accuracy, cost, and runtime coverage. Recommend Caddy
  access logs as the least-invasive default, pending a spike.
- **CPU semantics.** PM2 `monit.cpu` is an instantaneous snapshot; "Avg CPU" needs client-side
  smoothing or a short server-side rolling average — define which.
- **Cost of polling.** Frequent `pm2 describe` calls across many apps can add load; consider a
  single periodic sample feeding all views rather than per-tab polling.
- **Chart rendering under CSP.** No external chart CDN — bundle a lib or hand-draw SVG/div bars
  (the mockup's bars are simple enough to hand-draw).
- **Overlap with PRD-015 (monitoring).** Keep this scoped to the in-dashboard per-app tab; if a
  broader monitoring system lands, this tab should consume it rather than duplicate collection.
