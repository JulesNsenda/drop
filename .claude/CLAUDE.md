# DROP PaaS - Project Memory

## Project Overview

DROP (Deploy, Run, Operate, Publish) is a lightweight, self-hosted Platform as a Service (PaaS) engineered for the "drop folder and deploy" workflow. It enables zero-configuration deployment for Node.js, Python, Go, static sites, and containerized applications.

## Core Philosophy

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

---

## CRITICAL: Development Workflow Rules

### Before Writing ANY Code

**ALWAYS follow this sequence:**

1. **Read the PRD first**: `docs/specs/prd/PRD-XXX-feature-name.md`
2. **Read the Tasks file**: `docs/specs/tasks/TASKS-XXX-feature-name.md`
3. **Create feature branch**: Follow branching model in `docs/GIT-BRANCHING-MODEL.md`
4. **Implement task by task**: Work through tasks sequentially
5. **Mark tasks complete**: Update task file after each successful implementation
6. **Run tests**: Ensure all tests pass before marking complete
7. **Update documentation**: Use documenter agent after feature completion

### Git Branching Model (MANDATORY)

```bash
# ALWAYS create a feature branch from develop
git checkout develop
git pull origin develop
git checkout -b feature/DROP-XXX-description

# Commit with conventional commits
git commit -m "feat(scope): description"

# Push and create PR to develop
git push -u origin feature/DROP-XXX-description
```

**Branch Types:**
- `feature/DROP-XXX-description` - New features
- `bugfix/DROP-XXX-description` - Bug fixes
- `hotfix/DROP-XXX-description` - Production hotfixes (from main)
- `release/vX.Y.Z` - Release preparation

**NEVER commit directly to `main` or `develop`!**

### Task Completion Protocol

After implementing each task:
1. Run relevant tests
2. Update task file: Change `[ ]` to `[x]`
3. Add completion date and commit hash
4. Commit changes including task file update

### Clean Code Principles (MANDATORY)

1. **Single Responsibility**: One function/class does one thing
2. **DRY (Don't Repeat Yourself)**: Extract common logic
3. **KISS (Keep It Simple)**: Simplest solution that works
4. **Meaningful Names**: Self-documenting code
5. **Small Functions**: Max 20-30 lines per function
6. **No Magic Numbers**: Use named constants
7. **Error Handling**: Handle all edge cases
8. **Type Safety**: Full TypeScript strict mode
9. **Pure Functions**: Prefer functions without side effects
10. **Immutability**: Prefer `const` and immutable data structures

---

## Technology Stack

### Backend
- **Runtime**: Node.js 20+ with TypeScript 5.x (strict mode)
- **API Framework**: Hono (lightweight, fast)
- **CLI Framework**: Commander.js
- **Process Manager**: PM2
- **Reverse Proxy**: Caddy (automatic HTTPS)
- **File Watching**: chokidar

### Data Layer
- **Metadata Database**: SQLite (better-sqlite3)
- **App Databases**: PostgreSQL (per-app provisioning)
- **Cache**: Redis (optional plugin)

### Frontend Dashboard
- **Framework**: React 18+ with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS

### Infrastructure
- **Containerization**: Docker (optional)
- **Metrics**: Prometheus
- **Logging**: Structured JSON logs

## Directory Structure

```
/var/drop/
├── apps/drop-svc/              # Platform (replaced during upgrade)
│   ├── bin/                    # CLI and service binaries
│   ├── lib/                    # Libraries and dependencies
│   ├── dashboard/              # Web dashboard assets
│   └── version.json            # Version info
└── data/                       # User data (preserved during upgrade)
    ├── webapps/                # Deployed web applications
    ├── drop-svc/               # Platform state (drop.db, encryption.key)
    ├── db/                     # App databases (SQLite/PostgreSQL)
    ├── appdata/                # Per-app persistent data
    ├── logs/                   # All logs
    ├── appconf/                # Configuration files
    ├── backup/                 # Automated backups
    └── temp/                   # Temporary files
```

## Project Documentation Structure

```
docs/
├── specs/
│   ├── DROP-PAAS-SPECIFICATION.md   # Master specification (read-only reference)
│   ├── prd/                          # Product Requirement Documents
│   │   ├── _TEMPLATE.md              # PRD template
│   │   ├── PRD-001-watcher-service.md
│   │   ├── PRD-002-detector-service.md
│   │   └── ...
│   └── tasks/                        # Implementation Tasks
│       ├── _TEMPLATE.md              # Task template
│       ├── TASKS-001-watcher-service.md
│       ├── TASKS-002-detector-service.md
│       └── ...
├── api/                              # API Documentation
├── guides/                           # User Guides
└── GIT-BRANCHING-MODEL.md           # Branching strategy
```

## Coding Standards

### TypeScript
- Strict mode enabled (`strict: true`)
- No implicit `any` types
- Use interfaces over type aliases for objects
- Prefer `const` over `let`
- Use async/await over raw promises
- Handle all errors with try-catch

### Naming Conventions
- Files: kebab-case (`app-detector.ts`)
- Classes: PascalCase (`AppDetector`)
- Functions/Variables: camelCase (`detectAppType`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_RETRY_COUNT`)
- Interfaces: PascalCase with 'I' prefix optional (`IAppConfig` or `AppConfig`)

### Project Structure
```
src/
├── api/                # REST API routes (Hono)
├── cli/                # CLI commands (Commander)
├── core/               # Core business logic
│   ├── watcher/        # File system watcher
│   ├── detector/       # App type detection
│   ├── builder/        # Build pipeline
│   ├── router/         # Caddy configuration
│   └── database/       # Database management
├── managers/           # Domain managers
│   ├── app/            # App lifecycle management
│   ├── process/        # PM2 process management
│   ├── domain/         # Domain/hostname management
│   ├── secret/         # Secret management
│   └── health/         # Health monitoring
├── plugins/            # Plugin system
├── types/              # TypeScript type definitions
├── utils/              # Shared utilities
└── index.ts            # Entry point
```

## Key Design Patterns

1. **Convention over Configuration**: Auto-detect app types, ports, entry points
2. **Event-Driven Architecture**: Use EventEmitter for loose coupling
3. **Plugin Architecture**: Extensible through well-defined interfaces
4. **Immutable State**: Configuration snapshots for rollback
5. **Graceful Degradation**: Continue operating with reduced functionality

## Important Files

- `docs/specs/DROP-PAAS-SPECIFICATION.md` - Complete specification
- `docs/specs/prd/` - Product Requirements (READ BEFORE CODING)
- `docs/specs/tasks/` - Implementation Tasks (READ BEFORE CODING)
- `src/core/` - Core platform logic
- `src/api/` - REST API endpoints
- `src/cli/` - Command-line interface

## Testing Standards

- Unit tests: Jest with TypeScript
- Integration tests: Supertest for API
- Coverage target: 80%+
- Test file naming: `*.test.ts` or `*.spec.ts`

## Git Workflow

### Branch Naming
- Feature: `feature/<ticket>-<description>`
- Bugfix: `bugfix/<ticket>-<description>`
- Hotfix: `hotfix/<ticket>-<description>`
- Release: `release/<version>`

### Commit Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

## Commands

```bash
# Development
npm run dev          # Start development server
npm run build        # Build for production
npm run test         # Run tests
npm run lint         # Run ESLint
npm run format       # Format with Prettier

# CLI
drop deploy <app>    # Deploy an application
drop list            # List all applications
drop logs <app>      # View application logs
drop restart <app>   # Restart application
```

## Environment Variables

- `DROP_HOME` - Base installation directory (default: `/var/drop`)
- `DROP_DATA` - Data directory (default: `$DROP_HOME/data`)
- `DROP_LOG_LEVEL` - Log level (debug, info, warn, error)
- `DROP_API_PORT` - API server port (default: 3000)
- `DROP_DB_PATH` - SQLite database path

## Security Considerations

- Never commit `.env` files
- Use environment variables for secrets
- Validate all user input
- Sanitize file paths to prevent traversal attacks
- Use parameterized queries for database operations

## Agent Usage

### Available Agents
- **code-reviewer**: Use after writing code for quality review
- **test-runner**: Use after code changes to run and fix tests
- **api-designer**: Use when designing REST API endpoints
- **database-expert**: Use for database schema and queries
- **security-auditor**: Use for security reviews
- **documenter**: Use after feature completion to update docs

### Workflow Integration
1. Before coding: Read PRD → Read Tasks
2. During coding: Use relevant specialist agents
3. After coding: Use code-reviewer → test-runner → documenter
