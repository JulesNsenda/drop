---
name: pr-create
description: Create a pull request following DROP conventions. Use when ready to submit code changes for review.
allowed-tools: Bash, Read, Grep
---

# PR Create Skill

Create a pull request following DROP project conventions.

## Pre-PR Checklist

Before creating a PR:
```bash
# 1. Ensure tests pass
npm run test

# 2. Check linting
npm run lint

# 3. Build successfully
npm run build

# 4. Check for type errors
npx tsc --noEmit
```

## Branch Naming

- Feature: `feature/<ticket>-<description>`
- Bugfix: `bugfix/<ticket>-<description>`
- Hotfix: `hotfix/<ticket>-<description>`

Examples:
- `feature/DROP-123-add-postgres-support`
- `bugfix/DROP-456-fix-watcher-race-condition`
- `hotfix/DROP-789-security-patch`

## Creating the PR

```bash
# Push your branch
git push -u origin feature/DROP-123-description

# Create PR with gh CLI
gh pr create \
  --title "feat(core): add PostgreSQL support" \
  --body "## Summary
- Added PostgreSQL provisioning
- Implemented database lifecycle management
- Added connection pooling

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Related Issues
Closes #123" \
  --base develop \
  --head feature/DROP-123-description
```

## PR Title Format

Follow Conventional Commits:
```
<type>(<scope>): <description>
```

Types:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `refactor` - Code refactoring
- `test` - Test changes
- `chore` - Build/tooling changes

Scopes:
- `core` - Core engine
- `api` - REST API
- `cli` - Command line
- `db` - Database
- `proxy` - Reverse proxy
- `watcher` - File watcher

## PR Description Template

```markdown
## Summary
Brief description of what this PR does.

## Changes
- List of specific changes made
- Another change
- Third change

## Test Plan
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Documentation updated

## Screenshots (if applicable)
[Screenshots of UI changes]

## Related Issues
Closes #123
Related to #456

## Checklist
- [ ] Code follows project style guide
- [ ] Self-reviewed the code
- [ ] Tests pass locally
- [ ] Documentation updated
```

## After PR Creation

1. Request reviewers
2. Link related issues
3. Add appropriate labels
4. Monitor CI checks
5. Address review comments
