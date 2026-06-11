# PRD-003: Builder Service

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-003 |
| Feature | Builder Service |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Builder Service executes the build pipeline for detected applications, managing dependencies, compilation, and artifact generation. It supports framework-specific build strategies and provides build progress reporting.

### 1.2 Goals
- [ ] Execute build pipelines for all supported app types
- [ ] Support custom build commands via manifest
- [ ] Provide real-time build progress and logs
- [ ] Cache dependencies for faster rebuilds
- [ ] Support pre/post build hooks

### 1.3 Non-Goals
- Not detecting app types (Detector Service responsibility)
- Not managing running processes (Process Manager responsibility)

### 1.4 Success Metrics
- Build success rate > 95% for properly configured apps
- Incremental build time < 30 seconds for typical apps
- Zero build artifacts left on failed builds (cleanup)

---

## 2. Technical Design

### 2.1 Build Pipeline Stages
```
1. Pre-build hooks
2. Environment setup
3. Dependency installation
4. Build execution
5. Asset optimization
6. Post-build hooks
7. Health validation
```

### 2.2 Interfaces

```typescript
interface BuildContext {
  appName: string;
  appPath: string;
  appType: AppType;
  framework: string;
  config: AppConfig;
  env: Record<string, string>;
  previousBuild?: BuildResult;
}

interface BuildResult {
  success: boolean;
  duration: number;
  stages: BuildStageResult[];
  artifacts: string[];
  outputPath: string;
  errors: BuildError[];
  warnings: string[];
}

interface BuilderService {
  build(context: BuildContext): Promise<BuildResult>;
  cancel(appName: string): Promise<void>;
  getStatus(appName: string): BuildStatus | null;
}
```

### 2.3 Framework-Specific Strategies
| Framework | Install | Build | Output | Start |
|-----------|---------|-------|--------|-------|
| Next.js | `npm install` | `npm run build` | `.next` | `npm start` |
| Nuxt | `npm install` | `npm run build` | `.output` | `node .output/server/index.mjs` |
| Django | `pip install -r requirements.txt` | `collectstatic` | `staticfiles` | `gunicorn` |
| Static | N/A | N/A | `.` | N/A |

---

## 3. Implementation Plan

### 3.1 File Structure
```
src/
├── core/builder/
│   ├── index.ts
│   ├── builder.ts
│   ├── builder.types.ts
│   ├── strategies/
│   │   ├── base.ts
│   │   ├── nodejs.ts
│   │   ├── python.ts
│   │   └── static.ts
│   └── builder.test.ts
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
