# PRD-031: Build Caching

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-031 |
| Feature | Build Caching |
| Status | Planned |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Cache build artifacts per app so rebuilds only happen when source code actually
changes. On platform restart, start apps from cache without rebuilding.

## Changes

1. **Content hashing** - Compute hash from git SHA (git apps) or file content hash (folder apps) before each build
2. **Cache storage** - Store last successful build hash and artifacts in `data/build-cache/<appname>/`
3. **Skip npm install** - Compare `package-lock.json` hash; skip `npm ci` when unchanged
4. **Skip full build** - Compare overall content hash; skip build step entirely when unchanged
5. **Platform restart** - On startup, iterate known apps and start them without rebuilding if cache is valid
6. **Cache invalidation** - Explicitly invalidate via `POST /apps/:name/rebuild` or when app type changes
