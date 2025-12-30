---
name: test
description: Run tests for the DROP project. Use for running unit tests, integration tests, or generating coverage reports.
allowed-tools: Bash, Read, Grep
---

# Test Skill

Run tests for the DROP project using Jest.

## Test Commands

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run specific file
npm run test -- src/core/watcher.test.ts

# Run tests matching pattern
npm run test -- --testNamePattern="should detect"

# Watch mode
npm run test:watch

# Run only changed files
npm run test -- --onlyChanged

# Verbose output
npm run test -- --verbose

# Update snapshots
npm run test -- -u
```

## Test Structure

```
tests/
├── unit/               # Unit tests
│   ├── core/
│   ├── api/
│   └── utils/
├── integration/        # Integration tests
│   ├── api.test.ts
│   └── database.test.ts
└── fixtures/           # Test data
    └── apps/
```

## Coverage Requirements

- Statements: 80%+
- Branches: 75%+
- Functions: 80%+
- Lines: 80%+

## Common Test Patterns

### Testing Async Functions
```typescript
it('should resolve with data', async () => {
  const result = await asyncFunction();
  expect(result).toBe(expected);
});
```

### Testing Errors
```typescript
it('should throw on invalid input', async () => {
  await expect(asyncFunction(invalid))
    .rejects.toThrow('Expected error message');
});
```

### Mocking
```typescript
jest.mock('../service');
const mockService = service as jest.Mocked<typeof service>;
mockService.method.mockResolvedValue(data);
```
