# PRD-006: Event Bus

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-006 |
| Feature | Event Bus |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Event Bus provides a centralized publish/subscribe system for loose coupling between DROP components. It enables real-time notifications, webhook delivery, and system-wide event coordination.

### 1.2 Goals
- [ ] Provide typed event publishing and subscription
- [ ] Support wildcard event subscriptions
- [ ] Enable webhook delivery for external integrations
- [ ] Maintain event history for debugging

---

## 2. Technical Design

### 2.1 Interfaces

```typescript
interface EventBus {
  publish<T extends EventType>(event: T, payload: EventPayload<T>): void;
  subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe;
  subscribeAll(handler: (event: DropEvent) => void): Unsubscribe;
}

type EventType =
  | 'app:detected' | 'app:building' | 'app:built' | 'app:started'
  | 'app:stopped' | 'app:error' | 'app:removed'
  | 'deployment:started' | 'deployment:completed' | 'deployment:failed';
```

---

## 3. Implementation Plan

### 3.1 File Structure
```
src/
├── core/event-bus/
│   ├── index.ts
│   ├── event-bus.ts
│   ├── event-bus.types.ts
│   └── event-bus.test.ts
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
