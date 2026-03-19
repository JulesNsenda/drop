# PRD-001: Watcher Service

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-001 |
| Feature | Watcher Service |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Watcher Service monitors the `/var/drop/data/webapps` directory for file system changes, detecting new applications, modifications, and deletions. It serves as the entry point for the deployment pipeline, triggering builds and deployments automatically when users drop folders.

### 1.2 Goals
- [ ] Monitor webapps directory with configurable depth
- [ ] Detect hostname-based directory naming patterns
- [ ] Aggregate rapid changes with intelligent debouncing
- [ ] Emit events for downstream processing
- [ ] Support polling for network drives

### 1.3 Non-Goals
- Not handling build execution (Builder Service responsibility)
- Not determining app type (Detector Service responsibility)
- Not managing process lifecycle (Process Manager responsibility)

### 1.4 Success Metrics
- Event detection latency < 100ms
- Memory usage < 50MB for 1000 watched paths
- Zero missed events during normal operation

---

## 2. Background

### 2.1 Problem Statement
Users need a zero-configuration deployment experience where dropping a folder automatically triggers the full deployment pipeline. The Watcher Service provides this capability by monitoring the filesystem and translating changes into application lifecycle events.

### 2.2 User Stories
```
As a developer
I want to deploy my app by dropping a folder
So that I don't need to run deployment commands

As a platform operator
I want to monitor multiple host directories
So that I can manage many domains from one installation

As a developer
I want changes to be detected automatically
So that I can see updates without manual intervention
```

### 2.3 Reference
- Specification: `docs/specs/DROP-PAAS-SPECIFICATION.md` Section 2.1
- Related PRDs: PRD-002 (Detector), PRD-006 (Event Bus)

---

## 3. Technical Design

### 3.1 Architecture
```
                    ┌─────────────────┐
                    │  Watcher Service │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ chokidar FSW  │   │  Debouncer    │   │ Event Emitter │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │   Event Bus   │
                    └───────────────┘
```

### 3.2 Interfaces

```typescript
interface WatcherConfig {
  appsDir: string;
  debounceMs: number;          // Default: 2000ms
  ignorePatterns: string[];    // node_modules, .git, etc.
  maxDepth: number;            // Watch depth (default: 3)
  usePolling: boolean;         // For network drives
  pollInterval: number;        // Polling interval if enabled
}

interface WatchEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  appName: string;
  timestamp: Date;
  stats?: fs.Stats;
}

interface WatcherService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getWatchedPaths(): string[];
  on(event: WatcherEventType, handler: WatcherEventHandler): void;
}
```

### 3.3 Dependencies
- Internal: Event Bus, Logger
- External: `chokidar` (file watching), `path`, `fs/promises`

### 3.4 Events Emitted
| Event | Description |
|-------|-------------|
| `app:detected` | New app folder found |
| `app:changed` | App files modified |
| `app:removed` | App folder deleted |
| `app:config` | Configuration file changed |
| `host:added` | New hostname directory |
| `host:removed` | Hostname directory deleted |

---

## 4. Implementation Plan

### 4.1 File Structure
```
src/
├── core/watcher/
│   ├── index.ts              # Public exports
│   ├── watcher.ts            # Main WatcherService class
│   ├── watcher.types.ts      # Type definitions
│   ├── watcher.config.ts     # Default configuration
│   ├── debouncer.ts          # Change debouncing logic
│   ├── path-parser.ts        # Hostname pattern parsing
│   └── watcher.test.ts       # Unit tests
```

### 4.2 Key Components
1. **WatcherService**: Main service class managing chokidar instance
2. **Debouncer**: Aggregates rapid changes into single events
3. **PathParser**: Parses hostname_port patterns from directory names

### 4.3 Default Ignore Patterns
```javascript
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.drop/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/.env.local',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/venv/**',
];
```

---

## 5. Testing Strategy

### 5.1 Unit Tests
- [ ] WatcherService initialization
- [ ] Start/stop lifecycle
- [ ] Event emission on file changes
- [ ] Debouncing behavior
- [ ] Hostname pattern parsing
- [ ] Ignore pattern matching

### 5.2 Integration Tests
- [ ] End-to-end folder drop detection
- [ ] Multi-level directory watching
- [ ] Rapid change aggregation
- [ ] Network drive polling mode

### 5.3 Edge Cases
- Symbolic links: Follow by default
- Rapid successive changes: Debounce to single event
- Permission errors: Log and continue watching
- Missing directory: Create if not exists

---

## 6. Security Considerations

- [ ] Validate paths stay within webapps directory (prevent traversal)
- [ ] Rate limit event processing to prevent DoS
- [ ] Sanitize app names derived from paths
- [ ] Log suspicious path patterns

---

## 7. Rollout Plan

### 7.1 Feature Flag
- Flag name: N/A (core feature)
- Default: Always enabled

### 7.2 Rollout Stages
1. Development testing with mock filesystem
2. Integration testing with real directories
3. Staging deployment
4. Production deployment

---

## 8. Open Questions

- [x] Should we support watching multiple root directories? **Yes, via configuration**
- [x] How to handle very large directories (>10k files)? **Use polling mode with longer intervals**
- [ ] Should deleted apps trigger immediate cleanup?

---

## 9. Implementation Notes

_[To be added during implementation]_

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
