# DROP Clean Code Guidelines

These guidelines are **MANDATORY** for all DROP development. Code that doesn't follow these principles will be rejected in code review.

---

## Core Principles

### 1. Single Responsibility Principle (SRP)
Every function, class, and module should have ONE reason to change.

```typescript
// BAD - Multiple responsibilities
class AppManager {
  deployApp(path: string) { /* ... */ }
  sendEmail(to: string, subject: string) { /* ... */ }
  generateReport() { /* ... */ }
}

// GOOD - Single responsibility
class AppDeployer {
  deploy(path: string): Promise<DeployResult> { /* ... */ }
}

class NotificationService {
  sendEmail(to: string, subject: string): Promise<void> { /* ... */ }
}
```

### 2. DRY (Don't Repeat Yourself)
Extract common logic into reusable functions.

```typescript
// BAD - Duplicated logic
async function getUser(id: string) {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function getApp(id: string) {
  const response = await fetch(`/api/apps/${id}`);
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

// GOOD - Extracted common logic
async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

const getUser = (id: string) => apiGet<User>(`/users/${id}`);
const getApp = (id: string) => apiGet<App>(`/apps/${id}`);
```

### 3. KISS (Keep It Simple, Stupid)
Choose the simplest solution that works.

```typescript
// BAD - Over-engineered
class AppStatusCheckerFactory {
  createChecker(type: string): IAppStatusChecker {
    return new AppStatusCheckerImpl(new StatusStrategyFactory().create(type));
  }
}

// GOOD - Simple and direct
function checkAppStatus(appName: string): Promise<AppStatus> {
  return processManager.getStatus(appName);
}
```

---

## Naming Conventions

### Variables and Functions
Use descriptive, intention-revealing names.

```typescript
// BAD
const d = new Date();
const a = apps.filter(x => x.s === 'running');
function proc(n: string) { }

// GOOD
const currentDate = new Date();
const runningApps = apps.filter(app => app.status === 'running');
function processDeployment(appName: string) { }
```

### Booleans
Use `is`, `has`, `can`, `should` prefixes.

```typescript
// BAD
const running = true;
const admin = false;
const deploy = true;

// GOOD
const isRunning = true;
const hasAdminRole = false;
const canDeploy = true;
```

### Functions
Use verbs that describe the action.

```typescript
// BAD
function app(name: string) { }
function data() { }
function status() { }

// GOOD
function deployApp(name: string) { }
function fetchAppData() { }
function getAppStatus() { }
```

---

## Function Guidelines

### Keep Functions Small
Maximum 20-30 lines per function. If longer, extract sub-functions.

```typescript
// BAD - Too long
async function deployApplication(appPath: string) {
  // 100+ lines of code doing many things
}

// GOOD - Broken into logical steps
async function deployApplication(appPath: string): Promise<DeployResult> {
  const appType = await detectAppType(appPath);
  const buildResult = await buildApplication(appPath, appType);
  const processResult = await startProcess(appPath, buildResult);
  const routeResult = await configureRoute(appPath, processResult.port);

  return {
    success: true,
    url: routeResult.url,
  };
}
```

### Limit Parameters
Maximum 3 parameters. Use objects for more.

```typescript
// BAD - Too many parameters
function createApp(
  name: string,
  type: string,
  port: number,
  env: Record<string, string>,
  hostname: string,
  ssl: boolean
) { }

// GOOD - Use configuration object
interface CreateAppOptions {
  name: string;
  type: AppType;
  port?: number;
  env?: Record<string, string>;
  hostname?: string;
  ssl?: boolean;
}

function createApp(options: CreateAppOptions) { }
```

### Pure Functions
Prefer functions without side effects when possible.

```typescript
// BAD - Side effects
let total = 0;
function addToTotal(value: number) {
  total += value;  // Modifies external state
}

// GOOD - Pure function
function calculateTotal(values: number[]): number {
  return values.reduce((sum, val) => sum + val, 0);
}
```

---

## Error Handling

### Always Handle Errors
Never ignore errors. Log or rethrow with context.

```typescript
// BAD - Swallowed error
try {
  await deployApp(path);
} catch (e) {
  // Silently ignored
}

// BAD - Generic error
try {
  await deployApp(path);
} catch (e) {
  throw new Error('Error');
}

// GOOD - Proper error handling
try {
  await deployApp(path);
} catch (error) {
  logger.error('Deployment failed', { path, error });
  throw new DeploymentError(`Failed to deploy app at ${path}`, { cause: error });
}
```

### Use Custom Error Classes
Create specific error types for different failure modes.

```typescript
class DeploymentError extends Error {
  constructor(
    message: string,
    public readonly appName: string,
    public readonly stage: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DeploymentError';
  }
}

class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ValidationError';
  }
}
```

---

## TypeScript Best Practices

### Enable Strict Mode
Always use `strict: true` in tsconfig.json.

### Avoid `any`
Never use `any` without explicit justification.

```typescript
// BAD
function process(data: any) { }

// GOOD
function process(data: unknown) {
  if (isAppConfig(data)) {
    // Type-safe processing
  }
}

// If any is truly needed, document why
function handleLegacyData(data: any /* Legacy API returns untyped data */) { }
```

### Use Type Guards
Create type guards for runtime type checking.

```typescript
interface AppConfig {
  name: string;
  type: string;
}

function isAppConfig(value: unknown): value is AppConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'type' in value &&
    typeof (value as AppConfig).name === 'string' &&
    typeof (value as AppConfig).type === 'string'
  );
}
```

### Use `const` by Default
Only use `let` when reassignment is necessary.

```typescript
// BAD
let name = 'myapp';  // Never reassigned

// GOOD
const name = 'myapp';
```

---

## Constants

### No Magic Numbers/Strings
Use named constants for all literal values.

```typescript
// BAD
if (retries > 3) { }
setTimeout(callback, 5000);
if (status === 'running') { }

// GOOD
const MAX_RETRIES = 3;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const AppStatus = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  ERROR: 'errored',
} as const;

if (retries > MAX_RETRIES) { }
setTimeout(callback, HEALTH_CHECK_INTERVAL_MS);
if (status === AppStatus.RUNNING) { }
```

---

## Comments

### Code Should Be Self-Documenting
Prefer clear code over comments explaining unclear code.

```typescript
// BAD - Comment explains unclear code
// Check if app is ready
if (a.s === 1 && a.p > 0 && !a.e) { }

// GOOD - Self-documenting
const isAppReady = app.status === AppStatus.RUNNING
  && app.port > 0
  && !app.hasErrors;
if (isAppReady) { }
```

### When to Comment
- **Why**, not **what** (the code shows what)
- Complex algorithms
- Non-obvious business rules
- TODO/FIXME with ticket references

```typescript
// GOOD - Explains WHY
// Using 2 second debounce to prevent rapid rebuilds during file saves
// See: https://github.com/drop/issues/123
const DEBOUNCE_MS = 2000;

// BAD - Explains WHAT (obvious from code)
// Increment counter by 1
counter++;
```

---

## File Organization

### One Export Per File (for classes)
Keep files focused on a single responsibility.

```
// BAD
src/services/index.ts  // Contains 5 classes

// GOOD
src/services/
  ├── app-service.ts
  ├── build-service.ts
  ├── deploy-service.ts
  └── index.ts  // Re-exports only
```

### Import Order
1. Node.js built-ins
2. External packages
3. Internal modules
4. Types

```typescript
// Built-ins
import fs from 'fs';
import path from 'path';

// External packages
import { Hono } from 'hono';
import { z } from 'zod';

// Internal modules
import { AppRegistry } from '../managers/app';
import { logger } from '../utils/logger';

// Types
import type { AppConfig, DeployResult } from '../types';
```

---

## Testing Requirements

### Test File Naming
- Unit tests: `*.test.ts`
- Integration tests: `*.integration.test.ts`

### Test Structure
Use Arrange-Act-Assert pattern.

```typescript
describe('AppDeployer', () => {
  describe('deploy', () => {
    it('should deploy a valid Node.js application', async () => {
      // Arrange
      const appPath = '/test/apps/my-node-app';
      const deployer = new AppDeployer(mockRegistry);

      // Act
      const result = await deployer.deploy(appPath);

      // Assert
      expect(result.success).toBe(true);
      expect(result.url).toMatch(/^https:\/\//);
    });

    it('should throw ValidationError for invalid app path', async () => {
      // Arrange
      const invalidPath = '/nonexistent';
      const deployer = new AppDeployer(mockRegistry);

      // Act & Assert
      await expect(deployer.deploy(invalidPath))
        .rejects
        .toThrow(ValidationError);
    });
  });
});
```

---

## Code Review Checklist

Before submitting PR, verify:

- [ ] All functions are < 30 lines
- [ ] No magic numbers/strings
- [ ] No `any` types without justification
- [ ] All errors are handled properly
- [ ] Tests cover happy path and error cases
- [ ] No console.log in production code
- [ ] Follows naming conventions
- [ ] No code duplication
- [ ] TypeScript strict mode passes

---

## Quick Reference

| Principle | Rule |
|-----------|------|
| Function Length | Max 20-30 lines |
| Parameters | Max 3, use object for more |
| Nesting | Max 3 levels deep |
| File Length | Max 300 lines (guideline) |
| Line Length | Max 100 characters |
| Comments | Why, not what |
| Tests | 80%+ coverage |
