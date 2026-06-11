# PRD-004: Process Manager

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-004 |
| Feature | Process Manager |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Process Manager handles application lifecycle using PM2, providing process spawning, monitoring, clustering, graceful shutdown, and zero-downtime reloads. It serves as the bridge between DROP and the underlying process management infrastructure.

### 1.2 Goals
- [ ] Start/stop/restart applications via PM2
- [ ] Support clustering for multi-core utilization
- [ ] Provide zero-downtime reloads
- [ ] Monitor process health and metrics
- [ ] Handle graceful shutdown on SIGTERM

### 1.3 Non-Goals
- Not managing build processes (Builder Service responsibility)
- Not configuring reverse proxy (Router Service responsibility)

### 1.4 Success Metrics
- Process start time < 5 seconds
- Zero-downtime reload success rate > 99%
- Process restart on crash within 3 seconds

---

## 2. Technical Design

### 2.1 Interfaces

```typescript
interface ProcessConfig {
  name: string;
  script: string;
  cwd: string;
  instances: number | 'max';
  execMode: 'fork' | 'cluster';
  maxMemoryRestart: string;
  env: Record<string, string>;
  autorestart: boolean;
  killTimeout: number;
}

interface ProcessStatus {
  name: string;
  status: 'online' | 'stopping' | 'stopped' | 'errored' | 'launching';
  pid: number | null;
  instances: number;
  memory: number;
  cpu: number;
  uptime: number;
  restarts: number;
}

interface ProcessManager {
  start(appName: string, config: ProcessConfig): Promise<ProcessStatus>;
  stop(appName: string): Promise<void>;
  restart(appName: string): Promise<ProcessStatus>;
  reload(appName: string): Promise<ProcessStatus>;  // Zero-downtime
  scale(appName: string, instances: number): Promise<ProcessStatus>;
  getStatus(appName: string): Promise<ProcessStatus>;
  getLogs(appName: string, lines?: number): Promise<string>;
}
```

---

## 3. Implementation Plan

### 3.1 File Structure
```
src/
├── managers/process/
│   ├── index.ts
│   ├── process-manager.ts
│   ├── process-manager.types.ts
│   ├── pm2-client.ts
│   └── process-manager.test.ts
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
