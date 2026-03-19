# PRD-002: Detector Service

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-002 |
| Feature | Detector Service |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Detector Service intelligently identifies application types through multi-signal analysis combining file presence, content analysis, and manifest parsing. It determines the runtime, framework, build commands, and start commands for each application.

### 1.2 Goals
- [ ] Detect 15+ application types with high accuracy
- [ ] Support explicit configuration via drop.yaml manifest
- [ ] Provide confidence scores for detections
- [ ] Generate suggested configuration for detected apps

### 1.3 Non-Goals
- Not executing builds (Builder Service responsibility)
- Not managing configuration persistence (App Registry responsibility)

### 1.4 Success Metrics
- Detection accuracy > 95% for supported frameworks
- Detection time < 500ms for typical apps
- Zero false positives for explicit manifests

---

## 2. Background

### 2.1 Problem Statement
Different application types require different build and runtime configurations. Manual configuration is error-prone and time-consuming. The Detector Service automates this by analyzing application files to determine the correct configuration.

### 2.2 User Stories
```
As a developer
I want my app type detected automatically
So that I don't need to configure build commands

As a developer
I want to override detection with a manifest
So that I have control when needed

As a platform operator
I want detection confidence scores
So that I can identify potentially misconfigured apps
```

### 2.3 Reference
- Specification: `docs/specs/DROP-PAAS-SPECIFICATION.md` Section 2.2
- Related PRDs: PRD-001 (Watcher), PRD-003 (Builder)

---

## 3. Technical Design

### 3.1 Detection Pipeline
```
1. Check for explicit drop.yaml manifest (confidence: 1.0)
2. Analyze package.json (Node.js ecosystem)
3. Check for framework-specific config files
4. Analyze requirements.txt (Python)
5. Check for go.mod (Go)
6. Check for Cargo.toml (Rust)
7. Check for Dockerfile
8. Check for static site indicators
9. Fallback to unknown
```

### 3.2 Interfaces

```typescript
interface DetectionResult {
  type: AppType;
  framework: string | null;
  confidence: number;           // 0-1 confidence score
  detectedBy: string;           // What triggered detection
  suggestedConfig: Partial<AppConfig>;
  warnings: string[];           // Potential issues
}

type AppType =
  | 'node' | 'nextjs' | 'nuxt' | 'sveltekit' | 'remix' | 'astro'
  | 'express' | 'fastify' | 'hono' | 'nest'
  | 'static' | 'spa'
  | 'python' | 'django' | 'flask' | 'fastapi'
  | 'go' | 'rust' | 'docker' | 'proxy' | 'unknown';

interface DetectorService {
  detect(appPath: string): Promise<DetectionResult>;
  registerDetector(detector: AppDetector): void;
}
```

### 3.3 Framework Detection Matrix
| Indicator | Type | Framework | Confidence |
|-----------|------|-----------|------------|
| `drop.yaml` | From manifest | From manifest | 1.0 |
| `next.config.*` | nextjs | next | 0.95 |
| `nuxt.config.*` | nuxt | nuxt | 0.95 |
| `svelte.config.*` | sveltekit | sveltekit | 0.95 |
| `package.json` + `next` dep | nextjs | next | 0.85 |
| `manage.py` + `django` | python | django | 0.90 |
| `Dockerfile` | docker | custom | 0.85 |
| `index.html` only | static | vanilla | 0.70 |

---

## 4. Implementation Plan

### 4.1 File Structure
```
src/
├── core/detector/
│   ├── index.ts
│   ├── detector.ts           # Main DetectorService
│   ├── detector.types.ts     # Type definitions
│   ├── detectors/
│   │   ├── manifest.ts       # drop.yaml detector
│   │   ├── nodejs.ts         # Node.js ecosystem
│   │   ├── python.ts         # Python ecosystem
│   │   ├── go.ts             # Go detector
│   │   ├── rust.ts           # Rust detector
│   │   ├── docker.ts         # Dockerfile detector
│   │   └── static.ts         # Static site detector
│   └── detector.test.ts
```

---

## 5. Testing Strategy

### 5.1 Unit Tests
- [ ] Each individual detector
- [ ] Confidence score calculations
- [ ] Manifest parsing
- [ ] Framework detection matrix

### 5.2 Integration Tests
- [ ] Full detection pipeline
- [ ] Real application samples

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
