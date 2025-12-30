# DROP Git Branching Model

This document describes the git branching strategy for the DROP PaaS project.

## Branch Structure

```
main (production)
  │
  └── develop (integration)
        │
        ├── feature/DROP-xxx-description
        ├── bugfix/DROP-xxx-description
        └── release/vX.Y.Z
              │
              └── hotfix/DROP-xxx-description
```

## Primary Branches

### `main`
- **Purpose**: Production-ready code
- **Protection**: Requires PR review, passing CI, no direct pushes
- **Deploys to**: Production environment
- **Merges from**: `release/*`, `hotfix/*`

### `develop`
- **Purpose**: Integration branch for features
- **Protection**: Requires PR review, passing CI
- **Deploys to**: Staging environment
- **Merges from**: `feature/*`, `bugfix/*`

## Supporting Branches

### Feature Branches (`feature/*`)
```bash
# Create from develop
git checkout develop
git pull origin develop
git checkout -b feature/DROP-123-add-postgres-support

# Work on feature...
git add .
git commit -m "feat(db): add PostgreSQL provisioning"

# Push and create PR
git push -u origin feature/DROP-123-add-postgres-support
gh pr create --base develop
```

**Naming**: `feature/<ticket>-<short-description>`
- `feature/DROP-123-add-postgres-support`
- `feature/DROP-456-implement-clustering`

### Bugfix Branches (`bugfix/*`)
```bash
# Create from develop
git checkout develop
git pull origin develop
git checkout -b bugfix/DROP-789-fix-watcher-memory-leak

# Fix bug...
git add .
git commit -m "fix(watcher): resolve memory leak in file handler"

# Push and create PR
git push -u origin bugfix/DROP-789-fix-watcher-memory-leak
gh pr create --base develop
```

**Naming**: `bugfix/<ticket>-<short-description>`
- `bugfix/DROP-789-fix-watcher-memory-leak`
- `bugfix/DROP-012-correct-path-validation`

### Release Branches (`release/*`)
```bash
# Create from develop when ready for release
git checkout develop
git pull origin develop
git checkout -b release/v1.2.0

# Update version
npm version minor --no-git-tag-version
git add package.json
git commit -m "chore: bump version to 1.2.0"

# Fix any release issues...
git commit -m "fix: resolve release issue"

# Merge to main
git checkout main
git merge --no-ff release/v1.2.0
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin main --tags

# Merge back to develop
git checkout develop
git merge --no-ff release/v1.2.0
git push origin develop

# Delete release branch
git branch -d release/v1.2.0
```

**Naming**: `release/v<major>.<minor>.<patch>`
- `release/v1.0.0`
- `release/v1.2.0`

### Hotfix Branches (`hotfix/*`)
```bash
# Create from main for urgent production fixes
git checkout main
git pull origin main
git checkout -b hotfix/DROP-999-critical-security-fix

# Fix issue...
git add .
git commit -m "fix(security): patch authentication bypass"

# Bump patch version
npm version patch --no-git-tag-version
git add package.json
git commit -m "chore: bump version to 1.2.1"

# Merge to main
git checkout main
git merge --no-ff hotfix/DROP-999-critical-security-fix
git tag -a v1.2.1 -m "Hotfix v1.2.1"
git push origin main --tags

# Merge to develop
git checkout develop
git merge --no-ff hotfix/DROP-999-critical-security-fix
git push origin develop

# Delete hotfix branch
git branch -d hotfix/DROP-999-critical-security-fix
```

**Naming**: `hotfix/<ticket>-<short-description>`
- `hotfix/DROP-999-critical-security-fix`
- `hotfix/DROP-111-database-corruption-fix`

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types
| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, semicolons) |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding/updating tests |
| `chore` | Build process, dependencies, tools |

### Scopes
| Scope | Description |
|-------|-------------|
| `core` | Core engine |
| `api` | REST API |
| `cli` | Command line interface |
| `db` | Database layer |
| `proxy` | Reverse proxy (Caddy) |
| `watcher` | File system watcher |
| `builder` | Build pipeline |
| `auth` | Authentication |
| `security` | Security features |
| `docs` | Documentation |

### Examples
```
feat(db): add PostgreSQL 16 support

Implement PostgreSQL provisioning with:
- Automatic cluster initialization
- Connection pooling configuration
- WAL archiving setup

Closes #123

fix(watcher): resolve race condition in directory scanning

The debounce timer was not being reset properly when
multiple events occurred within the threshold window.

Fixes #456

chore(deps): update dependencies to latest versions

- hono: 3.x -> 4.x
- better-sqlite3: 9.x -> 10.x
- chokidar: 3.x -> 4.x
```

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

```
MAJOR.MINOR.PATCH
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Pre-release Versions
```
1.0.0-alpha.1
1.0.0-beta.1
1.0.0-rc.1
```

## Pull Request Guidelines

### Requirements
1. All CI checks must pass
2. At least one approval required
3. No unresolved conversations
4. Up-to-date with base branch

### PR Title Format
Same as commit message format:
```
feat(scope): description
```

### PR Template
```markdown
## Summary
Brief description of changes.

## Changes
- Change 1
- Change 2

## Test Plan
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Screenshots (if applicable)

## Related Issues
Closes #123
```

## Quick Reference

```bash
# Start new feature
git checkout develop && git pull
git checkout -b feature/DROP-xxx-description

# Start bugfix
git checkout develop && git pull
git checkout -b bugfix/DROP-xxx-description

# Start release
git checkout develop && git pull
git checkout -b release/vX.Y.Z

# Start hotfix
git checkout main && git pull
git checkout -b hotfix/DROP-xxx-description

# Update feature branch with latest develop
git checkout feature/DROP-xxx-description
git rebase develop

# Squash commits before PR
git rebase -i develop
```

## Branch Protection Rules

### `main`
- Require pull request reviews (1+)
- Require status checks to pass
- Require branches to be up to date
- Include administrators
- Restrict push access

### `develop`
- Require pull request reviews (1+)
- Require status checks to pass
- Allow squash merging
