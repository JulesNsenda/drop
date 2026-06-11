# PRD-008: Reverse Proxy & SSL (Caddy)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-008 |
| Feature | Reverse Proxy & SSL |
| Status | Not Started |
| Phase | 2 - Essential Features |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Reverse Proxy component manages Caddy server configuration, providing automatic SSL/TLS certificates, hostname routing, load balancing, and request proxying to application processes.

### 1.2 Goals
- [ ] Generate Caddy configuration dynamically
- [ ] Automatic HTTPS with Let's Encrypt
- [ ] Support hostname-based and path-based routing
- [ ] Hot TLS certificate reload
- [ ] Per-host HTTPS redirect configuration

---

## 2. Technical Design

### 2.1 Interfaces

```typescript
interface RouterService {
  addRoute(config: RouteConfig): Promise<void>;
  removeRoute(appName: string): Promise<void>;
  updateRoute(appName: string, config: RouteConfig): Promise<void>;
  reload(): Promise<void>;
  getRoutes(): Promise<RouteConfig[]>;
}

interface RouteConfig {
  hostname: string;
  port?: number;
  upstream: string;  // e.g., "localhost:3000"
  ssl: boolean;
  redirectHttps: boolean;
  staticPath?: string;
  tlsProtocols?: string;  // "+TLSv1.3, -TLSv1.0"
}
```

### 2.2 Caddyfile Generation
```
{hostname}:{port} {
  reverse_proxy localhost:{upstream_port}
  encode gzip
  tls {
    protocols tls1.2 tls1.3
  }
}
```

---

## 3. Implementation Plan

### 3.1 File Structure
```
src/
├── core/router/
│   ├── index.ts
│   ├── router.ts
│   ├── router.types.ts
│   ├── caddy-generator.ts
│   ├── caddy-api.ts
│   └── router.test.ts
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
