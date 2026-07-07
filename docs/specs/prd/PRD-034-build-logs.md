# PRD-034: Build Logs

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-034 |
| Feature | Build Logs |
| Status | In Progress (writer + read API done; dashboard viewer missing) |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Capture and store build output (stdout + stderr) for every deploy so users
can debug build failures from the dashboard.

## Changes

1. **Build log capture** - Pipe builder subprocess stdout/stderr to a log file per deploy
2. **Log storage** - Store in `data/logs/builds/<appname>/<timestamp>.log`
3. **API endpoint** - `GET /api/v1/apps/:name/build-logs` returns the latest build log; optional `?deploy=<timestamp>` for older logs
4. **Dashboard viewer** - Build log panel in app detail page with ANSI color rendering
5. **Failure display** - On deploy failure, API and dashboard surface the build log automatically
6. **Log rotation** - Keep last 10 build logs per app, delete older ones
