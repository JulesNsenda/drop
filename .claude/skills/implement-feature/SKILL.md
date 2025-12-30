---
name: implement-feature
description: Implement a DROP feature following the established workflow. Use when starting work on a new feature from the PRD/Tasks.
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, LSP
---

# Implement Feature Skill

This skill guides the implementation of DROP features following the mandatory development workflow.

## MANDATORY Workflow

### Step 1: Read Documentation (NEVER SKIP)

```bash
# 1. Read the PRD
Read docs/specs/prd/PRD-XXX-feature-name.md

# 2. Read the Tasks
Read docs/specs/tasks/TASKS-XXX-feature-name.md

# 3. Read related specification section
Read docs/specs/DROP-PAAS-SPECIFICATION.md (relevant section)
```

### Step 2: Create Feature Branch

```bash
# Ensure you're on develop and up to date
git checkout develop
git pull origin develop

# Create feature branch following naming convention
git checkout -b feature/DROP-XXX-feature-name
```

### Step 3: Implement Tasks Sequentially

For each task in the TASKS file:

1. **Mark task as in_progress** (if tracking externally)
2. **Implement the task**
3. **Write tests** for the implementation
4. **Run tests** to verify
5. **Mark task complete** in TASKS file:
   ```markdown
   - [x] Task description
   **Completion**: 2024-XX-XX
   **Commit**: abc1234
   ```
6. **Commit changes**:
   ```bash
   git add .
   git commit -m "feat(scope): implement task description"
   ```

### Step 4: Verify Implementation

```bash
# Run all tests
npm run test

# Run linting
npm run lint

# Build project
npm run build
```

### Step 5: Update Documentation

1. Mark PRD status as "Completed"
2. Update all task checkboxes
3. Add implementation notes to PRD
4. Update CHANGELOG.md

### Step 6: Create Pull Request

```bash
git push -u origin feature/DROP-XXX-feature-name

gh pr create \
  --title "feat(scope): implement feature name" \
  --body "## Summary
Implements PRD-XXX: Feature Name

## Changes
- List of changes

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing complete

Closes #XXX" \
  --base develop
```

## Clean Code Checklist

Before marking any task complete:

- [ ] Functions are < 30 lines
- [ ] No magic numbers (use constants)
- [ ] No `any` types
- [ ] All errors handled properly
- [ ] Tests written and passing
- [ ] JSDoc on public APIs
- [ ] No console.log in production code

## File Structure Template

```
src/core/{feature}/
├── index.ts              # Public exports
├── {feature}.ts          # Main implementation
├── {feature}.types.ts    # Type definitions
├── {feature}.config.ts   # Configuration defaults
├── {feature}.test.ts     # Unit tests
└── README.md             # Component documentation
```

## Example Implementation Flow

```typescript
// 1. Define types first (feature.types.ts)
export interface FeatureConfig {
  option1: string;
  option2: number;
}

export interface FeatureResult {
  success: boolean;
  data?: unknown;
}

// 2. Implement main class (feature.ts)
import type { FeatureConfig, FeatureResult } from './feature.types';
import { DEFAULT_CONFIG } from './feature.config';

export class FeatureService {
  private config: FeatureConfig;

  constructor(config: Partial<FeatureConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(): Promise<FeatureResult> {
    // Implementation
  }
}

// 3. Export public API (index.ts)
export { FeatureService } from './feature';
export type { FeatureConfig, FeatureResult } from './feature.types';

// 4. Write tests (feature.test.ts)
import { describe, it, expect } from '@jest/globals';
import { FeatureService } from './feature';

describe('FeatureService', () => {
  it('should execute successfully', async () => {
    const service = new FeatureService();
    const result = await service.execute();
    expect(result.success).toBe(true);
  });
});
```

## Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**: feat, fix, docs, style, refactor, perf, test, chore
**Scopes**: watcher, detector, builder, api, cli, db, proxy, auth

**Examples**:
```
feat(watcher): implement file system monitoring

- Add chokidar integration
- Implement debouncing logic
- Add ignore pattern handling

Implements TASKS-001 items 2.1-2.4
```
