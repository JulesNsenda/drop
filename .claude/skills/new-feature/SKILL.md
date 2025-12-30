---
name: new-feature
description: Create a new feature following DROP conventions. Use when starting development of a new feature to set up proper file structure.
allowed-tools: Bash, Read, Edit, Write, Glob
---

# New Feature Skill

Create a new feature following DROP project conventions.

## Feature Structure

When creating a new feature, establish:

```
src/
├── core/<feature>/
│   ├── index.ts           # Public exports
│   ├── <feature>.ts       # Main implementation
│   ├── <feature>.types.ts # Type definitions
│   └── <feature>.test.ts  # Unit tests
├── api/routes/<feature>.ts # API routes (if applicable)
└── cli/commands/<feature>.ts # CLI command (if applicable)
```

## Step-by-Step

### 1. Create Feature Directory
```bash
mkdir -p src/core/<feature>
```

### 2. Define Types
```typescript
// src/core/<feature>/<feature>.types.ts
export interface FeatureConfig {
  enabled: boolean;
  // ...
}

export interface FeatureResult {
  success: boolean;
  data?: unknown;
  error?: Error;
}
```

### 3. Implement Core Logic
```typescript
// src/core/<feature>/<feature>.ts
import type { FeatureConfig, FeatureResult } from './<feature>.types';

export class FeatureManager {
  private config: FeatureConfig;

  constructor(config: FeatureConfig) {
    this.config = config;
  }

  async execute(): Promise<FeatureResult> {
    // Implementation
  }
}
```

### 4. Export Public API
```typescript
// src/core/<feature>/index.ts
export { FeatureManager } from './<feature>';
export type { FeatureConfig, FeatureResult } from './<feature>.types';
```

### 5. Add Tests
```typescript
// src/core/<feature>/<feature>.test.ts
import { describe, it, expect } from '@jest/globals';
import { FeatureManager } from './<feature>';

describe('FeatureManager', () => {
  it('should execute successfully', async () => {
    const manager = new FeatureManager({ enabled: true });
    const result = await manager.execute();
    expect(result.success).toBe(true);
  });
});
```

### 6. Add API Route (if needed)
```typescript
// src/api/routes/<feature>.ts
import { Hono } from 'hono';
import { FeatureManager } from '../../core/<feature>';

const app = new Hono();

app.get('/', async (c) => {
  const manager = new FeatureManager(config);
  const result = await manager.execute();
  return c.json(result);
});

export default app;
```

### 7. Add CLI Command (if needed)
```typescript
// src/cli/commands/<feature>.ts
import { Command } from 'commander';
import { FeatureManager } from '../../core/<feature>';

export const featureCommand = new Command('<feature>')
  .description('Description of feature')
  .action(async () => {
    const manager = new FeatureManager(config);
    await manager.execute();
  });
```

## Checklist

- [ ] Types defined in `.types.ts`
- [ ] Core implementation in main file
- [ ] Public exports in `index.ts`
- [ ] Unit tests written
- [ ] API route added (if applicable)
- [ ] CLI command added (if applicable)
- [ ] Documentation updated
