# Contributing to DROP

Thanks for considering a contribution. This is a small project — please open
an issue before a large PR so we can agree on the approach first.

## Branching model

Full model: [docs/GIT-BRANCHING-MODEL.md](docs/GIT-BRANCHING-MODEL.md). The
short version:

- Branch off `develop`, never off `main`.
- Name branches `feature/<description>`, `bugfix/<description>`,
  `hotfix/<description>`.
- **Never commit directly to `main` or `develop`.** Always open a PR.

> **A push to `develop` deploys production.** This repo's CI ships and
> restarts the live service on every push to `develop` (and `main`) — there
> is no staging gate in between. This is exactly why direct commits to
> `develop` are not allowed: your change needs a PR and review first, not
> because of process for its own sake.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add PostgreSQL 16 support
fix(watcher): resolve race condition in directory scanning
docs(readme): correct install instructions
```

Common scopes: `core`, `api`, `cli`, `db`, `proxy`, `watcher`, `builder`,
`auth`, `security`, `docs`.

## Building

This repo has two `npm install`s, not one — the dashboard is a separate
package under `src/dashboard`:

```bash
npm install                       # server deps
(cd src/dashboard && npm install) # dashboard/site deps — do this once
npm run build                     # compiles the server AND builds the dashboard + public site
```

If you only changed backend code (`src/**/*.ts` outside `src/dashboard`),
skip the two frontend builds:

```bash
npm run build:server
```

Forgetting `cd src/dashboard && npm install` is the most common reason
`npm run build` fails on a fresh clone.

## Tests, lint, formatting

```bash
npm test                 # jest --forceExit — the suite leaks handles, this is expected
npm test -- -t "name"    # run a single test by name
npm run test:coverage    # coverage report
npm run lint             # ESLint
npm run lint:fix         # auto-fix lint issues
npm run format:check     # Prettier check (does not modify files)
```

**Do not run `npm run format` (or `prettier --write`) over files you edit.**
The tree is deliberately not uniformly Prettier-clean — neither CI workflow
runs `format:check` as a gate — and a blanket reformat produces a large diff
that buries the actual change and makes review harder. Match the surrounding
style by hand instead.

Tests are colocated next to the code they cover (`*.test.ts`), with shared
test helpers under `src/core/__testutils__/` and `src/api/__testutils__/`.

## Before opening a PR

1. `npm run lint` and `npm test` pass locally.
2. If your change is user-facing, add a line under `[Unreleased]` in
   `CHANGELOG.md`.
3. If your change affects a documented command, config option or API route,
   update the relevant doc alongside the code.
4. Open the PR against `develop`.

See the [pull request template](.github/PULL_REQUEST_TEMPLATE.md) for the
checklist that ships with every PR.
