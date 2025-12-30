---
name: lint
description: Lint and format DROP code. Use for checking code style, running ESLint, or formatting with Prettier.
allowed-tools: Bash, Read, Edit
---

# Lint Skill

Check and fix code style in the DROP project.

## Commands

```bash
# Check linting
npm run lint

# Fix auto-fixable issues
npm run lint:fix

# Format with Prettier
npm run format

# Check formatting only
npm run format:check

# Lint specific files
npx eslint src/core/**/*.ts

# Type check
npx tsc --noEmit
```

## ESLint Configuration

DROP uses ESLint with TypeScript support:
- `@typescript-eslint/eslint-plugin`
- `eslint-plugin-import`
- `eslint-plugin-security`

## Common Issues

### Unused Variables
```typescript
// Error: 'x' is defined but never used
const x = 1; // Remove or use

// Fix: Prefix with underscore if intentionally unused
const _unusedButRequired = param;
```

### Import Order
```typescript
// Correct order:
// 1. Node builtins
import fs from 'fs';
import path from 'path';

// 2. External packages
import { Hono } from 'hono';

// 3. Internal imports
import { AppManager } from './managers/app';

// 4. Types
import type { AppConfig } from './types';
```

### No Explicit Any
```typescript
// Error: Unexpected any
const data: any = response;

// Fix: Define proper type
interface ResponseData {
  id: string;
  name: string;
}
const data: ResponseData = response;
```

## Prettier Settings

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
```
