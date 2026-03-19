# PRD-XXX: [Feature Name]

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-XXX |
| Feature | [Feature Name] |
| Status | Not Started / In Progress / Completed |
| Phase | [Phase Number] |
| Priority | P0 / P1 / P2 / P3 |
| Owner | [Developer Name] |
| Created | YYYY-MM-DD |
| Updated | YYYY-MM-DD |

---

## 1. Overview

### 1.1 Summary
[Brief 2-3 sentence description of what this feature does and why it's needed]

### 1.2 Goals
- [ ] Goal 1
- [ ] Goal 2
- [ ] Goal 3

### 1.3 Non-Goals
- Not implementing X
- Not handling Y

### 1.4 Success Metrics
- Metric 1: [target]
- Metric 2: [target]

---

## 2. Background

### 2.1 Problem Statement
[Describe the problem this feature solves]

### 2.2 User Stories
```
As a [user type]
I want [capability]
So that [benefit]
```

### 2.3 Reference
- Specification: `docs/specs/DROP-PAAS-SPECIFICATION.md` Section X.Y
- Related PRDs: PRD-XXX, PRD-YYY

---

## 3. Technical Design

### 3.1 Architecture
[Describe how this feature fits into the overall architecture]

```
[ASCII diagram if helpful]
```

### 3.2 Interfaces

```typescript
// Key interfaces for this feature
interface FeatureConfig {
  // ...
}

interface FeatureResult {
  // ...
}
```

### 3.3 Dependencies
- Internal: [list internal dependencies]
- External: [list external packages]

### 3.4 Data Model
[Describe any database schemas or data structures]

---

## 4. Implementation Plan

### 4.1 File Structure
```
src/
├── core/[feature]/
│   ├── index.ts
│   ├── [feature].ts
│   ├── [feature].types.ts
│   └── [feature].test.ts
```

### 4.2 Key Components
1. **Component 1**: Description
2. **Component 2**: Description

### 4.3 API Endpoints (if applicable)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/... | ... |

---

## 5. Testing Strategy

### 5.1 Unit Tests
- [ ] Test case 1
- [ ] Test case 2

### 5.2 Integration Tests
- [ ] Test case 1
- [ ] Test case 2

### 5.3 Edge Cases
- Edge case 1: [handling]
- Edge case 2: [handling]

---

## 6. Security Considerations

- [ ] Input validation
- [ ] Authorization checks
- [ ] Data sanitization
- [ ] Audit logging

---

## 7. Rollout Plan

### 7.1 Feature Flag
- Flag name: `feature_xxx_enabled`
- Default: false

### 7.2 Rollout Stages
1. Development testing
2. Staging deployment
3. Production (canary)
4. Production (full)

---

## 8. Open Questions

- [ ] Question 1?
- [ ] Question 2?

---

## 9. Implementation Notes

_[Added during/after implementation]_

### 9.1 Deviations from Spec
- None / [list deviations]

### 9.2 Lessons Learned
- [lesson 1]
- [lesson 2]

### 9.3 Follow-up Items
- [ ] Follow-up 1
- [ ] Follow-up 2

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| YYYY-MM-DD | [name] | Initial draft |
