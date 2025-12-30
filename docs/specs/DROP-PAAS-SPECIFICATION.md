# DROP PaaS - Complete Platform Specification v2.0

## Deploy, Run, Operate, Publish

---

## Executive Summary

DROP is a lightweight, self-hosted Platform as a Service (PaaS) engineered for the **"drop folder and deploy"** workflow. DROP brings powerful simplicity to Node.js, Python, Go, static sites, and containerized applications.

### Core Philosophy

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

DROP eliminates deployment complexity by automatically detecting application types, provisioning resources, configuring reverse proxies, and managing the complete application lifecycle—all triggered by simply placing a folder in the apps directory.

### Key Differentiators

| Feature | DROP | Traditional PaaS |
|---------|------|-----------------|
| Configuration | Convention-based, auto-detect | YAML/config heavy |
| Deployment | Folder drop or git push | CLI commands only |
| Database | Auto-provisioned | Manual setup |
| SSL/TLS | Automatic via Caddy | Manual cert management |
| Scaling | Built-in clustering | Add-on required |
| Cost | Self-hosted, free | Per-dyno/container pricing |

### Target Users

- **Solo developers** wanting simple self-hosting without DevOps overhead
- **Agencies** managing multiple client sites with isolated environments
- **Startups** needing affordable, scalable infrastructure
- **Enterprise teams** wanting on-premise PaaS capabilities
- **Developers** tired of complex Kubernetes setups or expensive cloud hosting

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Core Components](#2-core-components)
3. [App Manifest Schema](#3-app-manifest-schema)
4. [App Detection & Convention System](#4-app-detection--convention-system)
5. [Database Provisioning](#5-database-provisioning)
6. [Reverse Proxy & SSL](#6-reverse-proxy--ssl)
7. [API Specification](#7-api-specification)
8. [CLI Specification](#8-cli-specification)
9. [Web Dashboard](#9-web-dashboard)
10. [Multi-Tenancy & Billing](#10-multi-tenancy--billing)
11. [Security Model](#11-security-model)
12. [Plugin Architecture](#12-plugin-architecture)
13. [Monitoring & Observability](#13-monitoring--observability)
14. [Directory Structure](#14-directory-structure)
15. [Technology Stack](#15-technology-stack)
16. [Implementation Phases](#16-implementation-phases)
17. [Cross-Platform Support](#17-cross-platform-support)
18. [Replication & High Availability](#18-replication--high-availability)
19. [Command Server](#19-command-server)
20. [System Maintenance](#20-system-maintenance)
21. [Appendices](#21-appendices)

---

## 1. Architecture Overview

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DROP PLATFORM v2.0                                  │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐             │
│  │  Watcher   │   │  Detector  │   │  Builder   │   │  Router    │             │
│  │ (chokidar) │──▶│  (smart    │──▶│ (pipeline) │──▶│  (Caddy)   │             │
│  │            │   │  analysis) │   │            │   │            │             │
│  └────────────┘   └────────────┘   └────────────┘   └────────────┘             │
│        │                │                │                │                     │
│        ▼                ▼                ▼                ▼                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                           CORE ENGINE                                    │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐            │   │
│  │  │   App     │  │  Process  │  │  Domain   │  │  Database │            │   │
│  │  │ Registry  │  │  Manager  │  │  Manager  │  │  Manager  │            │   │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘            │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐            │   │
│  │  │  Secret   │  │   Event   │  │   Log     │  │  Health   │            │   │
│  │  │  Manager  │  │    Bus    │  │ Aggregator│  │  Monitor  │            │   │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘            │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│        │                │                │                │                     │
│        ▼                ▼                ▼                ▼                     │
│  ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐                │
│  │  SQLite   │   │    PM2    │   │   Caddy   │   │ Prometheus│                │
│  │  (meta)   │   │ (process) │   │  (proxy)  │   │ (metrics) │                │
│  └───────────┘   └───────────┘   └───────────┘   └───────────┘                │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  INTERFACES                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   REST API   │  │     CLI      │  │  Dashboard   │  │   Webhooks   │        │
│  │   (Hono)     │  │ (Commander)  │  │   (React)    │  │   (Events)   │        │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘        │
├──────────────────────────────────────────────────────────────────────────────────┤
│  PLATFORM: /var/drop/apps/drop-svc   (Replaced during upgrade)                   │
│    ├── bin/                          (CLI and service binaries)                  │
│    ├── lib/                          (Libraries and dependencies)                │
│    ├── dashboard/                    (Web dashboard assets)                      │
│    └── version.json                  (Version info)                              │
├──────────────────────────────────────────────────────────────────────────────────┤
│  USER DATA: /var/drop/data           (Preserved during upgrade)                  │
│    ├── webapps/                      (Deployed web applications)                 │
│    ├── drop-svc/                     (Platform state: drop.db, encryption.key)   │
│    ├── db/                           (App databases - SQLite/PostgreSQL)         │
│    ├── appdata/                      (Per-app persistent data)                   │
│    ├── logs/                         (All logs: drop-svc, caddy, webapps)        │
│    ├── appconf/                      (Configuration: drop.yaml, caddy, plugins)  │
│    ├── backup/                       (Automated backups)                         │
│    └── temp/                         (Temporary files)                           │
├──────────────────────────────────────────────────────────────────────────────────┤
│  PLUGINS (Extensible)                                                            │
│    [PostgreSQL] [MySQL] [Redis] [S3] [Paystack] [Stripe] [SendGrid]             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Patterns

#### Deployment Flow
```
User drops folder → Watcher detects → Detector analyzes → Builder executes
     → Database provisioned → Process started → Proxy configured → URL live
```

#### Request Flow
```
HTTP Request → Caddy (TLS termination) → Host matching → App routing
     → Process proxy → Response → Caddy → Client
```

#### Event Flow
```
File change → Watcher → Event Bus → Subscribers (Builder, Logger, Webhooks)
     → State update → Registry → Dashboard/API notification
```

### 1.3 Routing Modes

DROP supports two routing modes:

#### Mode 1: Hostname-Based Routing (Production)
```
/var/drop/data/webapps/
├── api.example.com/           → https://api.example.com
│   ├── ROOT/                  → https://api.example.com/
│   └── v2/                    → https://api.example.com/v2
├── www.example.com/           → https://www.example.com
└── staging.example.com_8080/  → https://staging.example.com:8080
```

#### Mode 2: Subdomain Routing (Development/Simple)
```
/var/drop/data/webapps/
├── my-api/                    → https://my-api.drop.local
├── portfolio/                 → https://portfolio.drop.local
└── dashboard/                 → https://dashboard.drop.local
```

---

## 2. Core Components

### 2.1 Watcher Service

**Purpose**: Monitor the apps directory for new, modified, or deleted application folders with intelligent debouncing and change detection.

**Technology**: `chokidar` (Node.js) with custom event aggregation

**Architecture**:
```typescript
interface WatcherConfig {
  appsDir: string;
  debounceMs: number;          // Default: 2000ms
  ignorePatterns: string[];    // node_modules, .git, etc.
  maxDepth: number;            // Watch depth (default: 3)
  usePolling: boolean;         // For network drives
  pollInterval: number;        // Polling interval if enabled
}

interface WatchEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  appName: string;
  timestamp: Date;
  stats?: fs.Stats;
}
```

**Behavior**:
- Watches `/var/drop/data/apps` at configurable depth
- Aggregates rapid changes into single deployment events
- Detects hostname-based directory naming (`hostname_port` format)
- Supports `.conf` files for per-host configuration
- Supports `.alias.conf` files for hostname aliases
- Handles graceful restart on config changes

**Events Emitted**:
```typescript
// Core events
'app:detected'    // New app folder found
'app:changed'     // App files modified (triggers rebuild)
'app:removed'     // App folder deleted
'app:config'      // Configuration file changed

// Host events (hostname-based routing)
'host:added'      // New hostname directory
'host:removed'    // Hostname directory deleted
'host:alias'      // Alias configuration changed
```

**Ignore Patterns** (default):
```javascript
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.drop/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/.env.local',
  '**/dist/**',        // Ignored during watch, not deploy
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/venv/**',
];
```

**Replication Sync on Scan**:

When running as a replica, the Watcher triggers a sync from the primary whenever a directory scan occurs. This ensures replicas stay up-to-date even without continuous monitoring.

```typescript
class Watcher {
  private replicationManager?: ReplicationManager;

  async scanWebappsDirectory(): Promise<ScanResult> {
    const webappsDir = '/var/drop/data/webapps';
    const apps: DetectedApp[] = [];

    // Scan directory for apps
    const entries = await fs.readdir(webappsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const appPath = path.join(webappsDir, entry.name);
        const app = await this.detectApp(appPath);
        if (app) {
          apps.push(app);
        }
      }
    }

    // Trigger replication sync if running as replica
    if (this.replicationManager?.isReplica()) {
      await this.replicationManager.syncOnScan();
    }

    return { apps, scannedAt: new Date() };
  }
}
```

### 2.2 Detector Service

**Purpose**: Intelligently identify application types through multi-signal analysis combining file presence, content analysis, and manifest parsing.

**Detection Pipeline**:
```
1. Check for explicit drop.json manifest
2. Analyze package.json (Node.js ecosystem)
3. Check for framework-specific files
4. Analyze requirements.txt (Python)
5. Check for go.mod (Go)
6. Check for Cargo.toml (Rust)
7. Check for Dockerfile
8. Check for static site indicators
9. Fallback to unknown
```

**Detection Results**:
```typescript
interface DetectionResult {
  type: AppType;
  framework: string | null;
  confidence: number;           // 0-1 confidence score
  detectedBy: string;           // What triggered detection
  suggestedConfig: Partial<AppConfig>;
  warnings: string[];           // Potential issues
}

type AppType =
  | 'node'      // Generic Node.js
  | 'nextjs'    // Next.js
  | 'nuxt'      // Nuxt.js
  | 'sveltekit' // SvelteKit
  | 'remix'     // Remix
  | 'astro'     // Astro
  | 'express'   // Express.js
  | 'fastify'   // Fastify
  | 'hono'      // Hono
  | 'nest'      // NestJS
  | 'static'    // Static site
  | 'spa'       // Single-page app (React, Vue, etc.)
  | 'python'    // Generic Python
  | 'django'    // Django
  | 'flask'     // Flask
  | 'fastapi'   // FastAPI
  | 'go'        // Go
  | 'rust'      // Rust
  | 'docker'    // Dockerfile present
  | 'proxy'     // Reverse proxy config
  | 'unknown';  // Cannot determine
```

**Framework Detection Matrix**:

| Indicator | Type | Framework | Confidence |
|-----------|------|-----------|------------|
| `drop.json` | From manifest | From manifest | 1.0 |
| `next.config.*` | nextjs | next | 0.95 |
| `nuxt.config.*` | nuxt | nuxt | 0.95 |
| `svelte.config.*` | sveltekit | sveltekit | 0.95 |
| `remix.config.*` | remix | remix | 0.95 |
| `astro.config.*` | astro | astro | 0.95 |
| `nest-cli.json` | node | nest | 0.95 |
| `package.json` + `next` dep | nextjs | next | 0.85 |
| `package.json` + `express` dep | node | express | 0.80 |
| `manage.py` + `django` | python | django | 0.90 |
| `app.py` + `flask` | python | flask | 0.85 |
| `main.py` + `fastapi` | python | fastapi | 0.80 |
| `go.mod` | go | generic | 0.90 |
| `Cargo.toml` | rust | generic | 0.90 |
| `Dockerfile` | docker | custom | 0.85 |
| `*.proxy` file | proxy | reverse-proxy | 1.0 |
| `index.html` only | static | vanilla | 0.70 |

### 2.3 Builder Service

**Purpose**: Execute the build pipeline for detected applications, managing dependencies, compilation, and artifact generation.

**Build Pipeline Stages**:
```
1. Pre-build hooks
2. Environment setup
3. Dependency installation
4. Build execution
5. Asset optimization
6. Post-build hooks
7. Health validation
```

**Builder Interface**:
```typescript
interface BuildContext {
  appName: string;
  appPath: string;
  appType: AppType;
  framework: string;
  config: AppConfig;
  env: Record<string, string>;
  previousBuild?: BuildResult;
}

interface BuildResult {
  success: boolean;
  duration: number;
  stages: BuildStageResult[];
  artifacts: string[];
  outputPath: string;
  errors: BuildError[];
  warnings: string[];
}

interface BuildStageResult {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  logs: string[];
}
```

**Framework-Specific Build Strategies**:

```typescript
const BUILD_STRATEGIES: Record<string, BuildStrategy> = {
  nextjs: {
    install: 'npm install',
    build: 'npm run build',
    output: '.next',
    start: 'npm start',
    standalone: true,  // Supports standalone output
  },
  nuxt: {
    install: 'npm install',
    build: 'npm run build',
    output: '.output',
    start: 'node .output/server/index.mjs',
  },
  sveltekit: {
    install: 'npm install',
    build: 'npm run build',
    output: 'build',
    start: 'node build/index.js',
    adapter: 'node',  // Requires node adapter
  },
  static: {
    install: null,
    build: null,
    output: '.',
    start: null,  // Served by Caddy directly
  },
  express: {
    install: 'npm install',
    build: 'npm run build --if-present',
    output: '.',
    start: 'npm start',
  },
  django: {
    install: 'pip install -r requirements.txt',
    build: 'python manage.py collectstatic --noinput',
    output: 'staticfiles',
    start: 'gunicorn ${APP_MODULE}:application',
  },
  fastapi: {
    install: 'pip install -r requirements.txt',
    build: null,
    output: '.',
    start: 'uvicorn main:app --host 0.0.0.0 --port ${PORT}',
  },
};
```

### 2.4 Process Manager

**Purpose**: Manage application lifecycle using PM2 with enhanced monitoring, clustering, and graceful shutdown capabilities.

**PM2 Integration**:
```typescript
interface ProcessConfig {
  name: string;
  script: string;
  cwd: string;
  instances: number | 'max';
  execMode: 'fork' | 'cluster';
  maxMemoryRestart: string;
  env: Record<string, string>;
  autorestart: boolean;
  watchDelay: number;
  killTimeout: number;
  listenTimeout: number;
  errorFile: string;
  outFile: string;
  mergeLogs: boolean;
  time: boolean;
}

class ProcessManager {
  async start(appName: string): Promise<ProcessStatus>;
  async stop(appName: string): Promise<void>;
  async restart(appName: string): Promise<ProcessStatus>;
  async reload(appName: string): Promise<ProcessStatus>;  // Zero-downtime
  async scale(appName: string, instances: number): Promise<ProcessStatus>;
  async getStatus(appName: string): Promise<ProcessStatus>;
  async getLogs(appName: string, options: LogOptions): Promise<LogStream>;
  async getMetrics(appName: string): Promise<ProcessMetrics>;
}

interface ProcessStatus {
  name: string;
  status: 'online' | 'stopping' | 'stopped' | 'errored' | 'launching';
  pid: number | null;
  instances: number;
  memory: number;
  cpu: number;
  uptime: number;
  restarts: number;
  unstableRestarts: number;
}

interface ProcessMetrics {
  memory: { used: number; limit: number; percentage: number };
  cpu: { usage: number; system: number; user: number };
  eventLoop: { latency: number; };
  requests?: { total: number; active: number; };
}
```

**Process Ecosystem Generation**:
```javascript
// Generated at /var/drop/data/drop-svc/pm2/{app-name}.config.cjs
module.exports = {
  apps: [{
    name: 'my-app',
    script: '/var/drop/data/webapps/my-app/server.js',
    cwd: '/var/drop/data/webapps/my-app',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '256M',
    kill_timeout: 5000,
    listen_timeout: 10000,
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DATABASE_URL: 'file:/var/drop/data/db/my-app.db',
      APP_NAME: 'my-app',
      APP_URL: 'https://my-app.drop.local',
      DROP_APP_HOME: '/var/drop/data/appdata/my-app',
    },
    error_file: '/var/drop/data/logs/webapps/my-app/error.log',
    out_file: '/var/drop/data/logs/webapps/my-app/out.log',
    merge_logs: true,
    time: true,
  }]
};
```

**Application Process Communication Protocol (APCP)**:

DROP provides a binary protocol for communication between the platform and running applications, enabling lifecycle hooks and runtime coordination.

```typescript
interface APCPConfig {
  socketPath: string;                    // Unix socket or named pipe
  timeout: number;                       // Message timeout (ms)
  maxMessageSize: number;                // Max message size (bytes)
}

// Lifecycle hooks that apps can implement
interface AppLifecycleHooks {
  onStarting(): Promise<void>;           // Called before app starts accepting traffic
  onStartupComplete(): Promise<void>;    // Called when app is fully started
  onStopping(): Promise<void>;           // Called when graceful shutdown begins
  onExit(): Promise<void>;               // Called just before process exit
}

class APCPServer {
  private socket: net.Server;

  async start(config: APCPConfig): Promise<void> {
    this.socket = net.createServer((conn) => {
      this.handleConnection(conn);
    });

    this.socket.listen(config.socketPath);
  }

  private async handleConnection(conn: net.Socket): Promise<void> {
    const reader = new APCPMessageReader(conn);

    // Authentication handshake
    const authMsg = await reader.read();
    if (!this.verifyAppAuth(authMsg)) {
      conn.destroy();
      return;
    }

    // Handle messages
    conn.on('data', async (data) => {
      const message = this.parseMessage(data);
      await this.handleMessage(message, conn);
    });
  }

  private async handleMessage(msg: APCPMessage, conn: net.Socket): Promise<void> {
    switch (msg.type) {
      case 'READY':
        // App signals it's ready to accept traffic
        await this.onAppReady(msg.appName);
        break;

      case 'HEALTH':
        // App reports health status
        await this.onHealthReport(msg.appName, msg.payload);
        break;

      case 'METRICS':
        // App reports metrics
        await this.onMetricsReport(msg.appName, msg.payload);
        break;

      case 'LOG':
        // Structured log message
        await this.onLogMessage(msg.appName, msg.payload);
        break;

      case 'SHUTDOWN_ACK':
        // App acknowledges shutdown request
        await this.onShutdownAck(msg.appName);
        break;
    }
  }

  // Send shutdown signal to app
  async sendShutdown(appName: string, timeout: number): Promise<boolean> {
    const conn = this.connections.get(appName);
    if (!conn) return false;

    await this.sendMessage(conn, {
      type: 'SHUTDOWN',
      payload: { timeout, graceful: true },
    });

    // Wait for acknowledgment
    return this.waitForShutdownAck(appName, timeout);
  }
}

interface APCPMessage {
  version: number;
  type: APCPMessageType;
  appName: string;
  timestamp: Date;
  payload: Buffer;
}

type APCPMessageType =
  | 'AUTH'              // Authentication handshake
  | 'READY'             // App is ready
  | 'HEALTH'            // Health report
  | 'METRICS'           // Metrics report
  | 'LOG'               // Log message
  | 'SHUTDOWN'          // Shutdown request (from DROP)
  | 'SHUTDOWN_ACK'      // Shutdown acknowledgment (from app)
  | 'CONFIG_RELOAD';    // Config change notification
```

**Application-Side Client (Node.js SDK)**:

```typescript
// drop-sdk package for apps to communicate with DROP
import { DropClient } from '@drop/sdk';

const drop = new DropClient();

// Register lifecycle hooks
drop.onStarting(async () => {
  console.log('App starting...');
  await initializeDatabase();
});

drop.onStopping(async () => {
  console.log('Graceful shutdown initiated...');
  await closeConnections();
  await flushBuffers();
});

// Signal ready after startup
drop.ready();

// Report custom health
drop.reportHealth({
  status: 'healthy',
  dbConnected: true,
  cacheHitRate: 0.95,
});

// Report custom metrics
drop.reportMetrics({
  requestsPerSecond: 150,
  averageLatency: 45,
  activeConnections: 23,
});
```

**stdout/stderr Capture**:

```typescript
class ProcessOutputCapture {
  private outBuffer: string[] = [];
  private errBuffer: string[] = [];

  captureProcess(proc: ChildProcess, appName: string): void {
    // Capture stdout
    proc.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.outBuffer.push(line);
          this.logger.info(`[${appName}] ${line}`);
        }
      }
      this.flushBuffer('stdout', appName);
    });

    // Capture stderr
    proc.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          this.errBuffer.push(line);
          this.logger.error(`[${appName}] ${line}`);
        }
      }
      this.flushBuffer('stderr', appName);
    });
  }

  private flushBuffer(stream: 'stdout' | 'stderr', appName: string): void {
    const buffer = stream === 'stdout' ? this.outBuffer : this.errBuffer;
    const logFile = stream === 'stdout'
      ? `/var/drop/data/logs/webapps/${appName}/out.log`
      : `/var/drop/data/logs/webapps/${appName}/error.log`;

    // Write to log file with timestamps
    const lines = buffer.splice(0, buffer.length);
    const content = lines.map(l => `${new Date().toISOString()} ${l}`).join('\n');
    fs.appendFile(logFile, content + '\n');
  }
}
```

### 2.5 Domain Manager

**Purpose**: Configure reverse proxy routing, SSL certificates, and domain management via Caddy with automatic HTTPS.

**Domain Configuration**:
```typescript
interface DomainConfig {
  appName: string;
  subdomain: string;
  customDomains: string[];
  ssl: SSLConfig;
  routing: RoutingConfig;
}

interface SSLConfig {
  enabled: boolean;
  provider: 'acme' | 'custom' | 'self-signed';
  email?: string;
  certPath?: string;
  keyPath?: string;
}

interface RoutingConfig {
  mode: 'subdomain' | 'hostname';
  contextPath: string;
  upstream: string;
  healthCheck: HealthCheckConfig;
  headers: Record<string, string>;
  redirectHttps: boolean;
}

interface HealthCheckConfig {
  path: string;
  interval: string;
  timeout: string;
  unhealthyThreshold: number;
}
```

### 2.6 Database Manager

**Purpose**: Automatic database provisioning, connection management, backups, and migrations for application databases.

**Supported Databases**:
```typescript
type DatabaseType = 'sqlite' | 'postgresql' | 'mysql' | 'mongodb';

interface DatabaseConfig {
  type: DatabaseType;
  name: string;
  autoProvision: boolean;
  backupSchedule?: string;  // Cron expression
  maxConnections?: number;
}

interface ProvisionedDatabase {
  type: DatabaseType;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  url: string;              // Full connection URL
  path?: string;            // For SQLite
}
```

### 2.7 App Registry

**Purpose**: Maintain persistent state of all deployed applications, configurations, and deployment history.

**Database Schema**:
```sql
-- Core tables
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  hostname TEXT,                    -- For hostname-based routing
  context_path TEXT DEFAULT '/',    -- Context path within hostname
  type TEXT NOT NULL,
  framework TEXT,
  status TEXT DEFAULT 'stopped',
  port INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  config JSON,
  env JSON,
  UNIQUE(hostname, context_path)
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  version TEXT,
  status TEXT,                      -- pending, building, deploying, success, failed
  trigger TEXT,                     -- manual, file-change, git-push, api
  git_commit TEXT,
  git_branch TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  build_logs TEXT,
  error TEXT
);

CREATE TABLE host_aliases (
  alias TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE host_configs (
  hostname TEXT PRIMARY KEY,
  config JSON,                      -- HTTPS redirect, headers, etc.
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE databases (
  id TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials JSON,                 -- Encrypted
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,              -- Encrypted
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(app_id, key)
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  api_key TEXT UNIQUE,
  plan TEXT DEFAULT 'free',
  limits JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app_tenants (
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, tenant_id)
);

-- Indexes
CREATE INDEX idx_apps_hostname ON apps(hostname);
CREATE INDEX idx_apps_status ON apps(status);
CREATE INDEX idx_deployments_app_id ON deployments(app_id);
CREATE INDEX idx_deployments_status ON deployments(status);
```

### 2.8 Event Bus

**Purpose**: Decouple components through publish-subscribe event system enabling plugins, webhooks, and real-time updates.

**Event System**:
```typescript
interface EventBus {
  emit(event: DropEvent): void;
  on(type: string, handler: EventHandler): void;
  off(type: string, handler: EventHandler): void;
  once(type: string, handler: EventHandler): void;
}

type DropEvent =
  | AppEvent
  | DeploymentEvent
  | ProcessEvent
  | SystemEvent;

interface AppEvent {
  type: 'app:created' | 'app:updated' | 'app:deleted' | 'app:started' | 'app:stopped';
  appName: string;
  timestamp: Date;
  data: any;
}

interface DeploymentEvent {
  type: 'deployment:started' | 'deployment:progress' | 'deployment:success' | 'deployment:failed';
  appName: string;
  deploymentId: string;
  timestamp: Date;
  data: any;
}

---

## 3. App Manifest Schema

### 3.1 Complete Schema (`drop.json`)

```json
{
  "$schema": "https://drop.dev/schema/v2.json",
  "name": "my-app",
  "version": "1.0.0",
  "description": "My awesome application",
  "type": "node",
  "framework": "express",

  "runtime": {
    "version": "20",
    "entry": "server.js",
    "command": "npm start"
  },

  "build": {
    "install": "npm ci --production=false",
    "command": "npm run build",
    "output": "dist",
    "cache": ["node_modules", ".next/cache"]
  },

  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "timeout": 30000
  },

  "domain": {
    "subdomain": "my-app",
    "hostname": "api.example.com",
    "contextPath": "/v1",
    "custom": ["myapp.com", "www.myapp.com"],
    "redirectHttps": true
  },

  "database": {
    "type": "sqlite",
    "name": "myapp",
    "autoMigrate": true
  },

  "env": {
    "NODE_ENV": "production",
    "LOG_LEVEL": "info",
    "API_KEY": "@secret:api_key",
    "DATABASE_URL": "@database:url"
  },

  "resources": {
    "memory": "256mb",
    "instances": 1,
    "maxInstances": 4,
    "autoScale": false
  },

  "health": {
    "enabled": true,
    "path": "/health",
    "interval": 30,
    "timeout": 5,
    "unhealthyThreshold": 3,
    "healthyThreshold": 2
  },

  "hooks": {
    "prebuild": "npm run lint",
    "postbuild": "npm run test:ci",
    "predeploy": "npm run migrate",
    "postdeploy": "curl -X POST https://hooks.slack.com/...",
    "prestop": "npm run cleanup"
  },

  "logs": {
    "stdout": true,
    "file": true,
    "maxSize": "10mb",
    "maxFiles": 5,
    "level": "info"
  },

  "features": {
    "websocket": true,
    "compression": true,
    "cors": {
      "enabled": true,
      "origins": ["https://example.com"]
    }
  }
}
```

### 3.2 Minimal Manifest

For most applications, only the name is required:

```json
{
  "name": "my-app"
}
```

Everything else is auto-detected or uses intelligent defaults.

### 3.3 Framework-Specific Defaults

**Node.js (`type: "node"`)**:
```json
{
  "runtime": { "version": "20", "entry": "auto-detect" },
  "build": { "install": "npm install" },
  "server": { "port": 3000 },
  "resources": { "memory": "256mb", "instances": 1 }
}
```

**Next.js (`type: "nextjs"`)**:
```json
{
  "runtime": { "version": "20" },
  "build": {
    "install": "npm ci",
    "command": "npm run build",
    "output": ".next"
  },
  "server": { "port": 3000 },
  "resources": { "memory": "512mb", "instances": 1 }
}
```

**Static Site (`type: "static"`)**:
```json
{
  "build": { "output": "." },
  "server": { "port": null },
  "resources": { "memory": null }
}
```

**Python/Django (`type: "django"`)**:
```json
{
  "runtime": { "version": "3.11" },
  "build": {
    "install": "pip install -r requirements.txt",
    "command": "python manage.py collectstatic --noinput"
  },
  "server": { "port": 8000, "command": "gunicorn" },
  "resources": { "memory": "512mb", "instances": 1 }
}
```

**Python/FastAPI (`type: "fastapi"`)**:
```json
{
  "runtime": { "version": "3.11" },
  "build": { "install": "pip install -r requirements.txt" },
  "server": {
    "port": 8000,
    "command": "uvicorn main:app --host 0.0.0.0"
  },
  "resources": { "memory": "256mb", "instances": 1 }
}
```

### 3.4 Special Value References

DROP supports special value references in the `env` section:

| Reference | Description | Example |
|-----------|-------------|---------|
| `@secret:key` | Reference a secret | `@secret:api_key` |
| `@database:url` | Database connection URL | `@database:url` |
| `@database:host` | Database host | `@database:host` |
| `@database:port` | Database port | `@database:port` |
| `@database:name` | Database name | `@database:name` |
| `@database:user` | Database username | `@database:user` |
| `@database:pass` | Database password | `@database:pass` |
| `@app:name` | Application name | `@app:name` |
| `@app:url` | Application URL | `@app:url` |
| `@app:port` | Assigned port | `@app:port` |
| `@app:home` | App data directory | `@app:home` |

### 3.5 Proxy Configuration (`.proxy` files)

For reverse proxy to external services:

```ini
# /var/drop/data/webapps/api.example.com/legacy.proxy
url=http://legacy-server:8080
timeout=60000
preserveHost=true
websocket=true
```

---

## 4. App Detection & Convention System

### 4.1 Detection Algorithm

```typescript
async function detectAppType(appPath: string): Promise<DetectionResult> {
  const files = await fs.readdir(appPath);
  const signals: DetectionSignal[] = [];

  // 1. Explicit manifest (highest priority)
  if (files.includes('drop.json')) {
    const manifest = await readManifest(appPath);
    return {
      type: manifest.type || await inferType(appPath, manifest),
      framework: manifest.framework,
      confidence: 1.0,
      detectedBy: 'drop.json manifest',
      suggestedConfig: manifest,
      warnings: validateManifest(manifest),
    };
  }

  // 2. Node.js ecosystem detection
  if (files.includes('package.json')) {
    const pkg = await readPackageJson(appPath);
    const nodeResult = detectNodeFramework(pkg, files);
    signals.push(nodeResult);
  }

  // 3. Python detection
  if (files.includes('requirements.txt') || files.includes('pyproject.toml')) {
    const pythonResult = await detectPythonFramework(appPath, files);
    signals.push(pythonResult);
  }

  // 4. Go detection
  if (files.includes('go.mod')) {
    signals.push({
      type: 'go',
      framework: 'generic',
      confidence: 0.90,
      detectedBy: 'go.mod',
    });
  }

  // 5. Rust detection
  if (files.includes('Cargo.toml')) {
    signals.push({
      type: 'rust',
      framework: 'generic',
      confidence: 0.90,
      detectedBy: 'Cargo.toml',
    });
  }

  // 6. Docker detection
  if (files.includes('Dockerfile')) {
    signals.push({
      type: 'docker',
      framework: 'custom',
      confidence: 0.85,
      detectedBy: 'Dockerfile',
    });
  }

  // 7. Proxy detection
  const proxyFiles = files.filter(f => f.endsWith('.proxy'));
  if (proxyFiles.length > 0) {
    signals.push({
      type: 'proxy',
      framework: 'reverse-proxy',
      confidence: 1.0,
      detectedBy: '.proxy file',
    });
  }

  // 8. Static site detection (lowest priority)
  if (files.includes('index.html')) {
    signals.push({
      type: 'static',
      framework: detectStaticFramework(files),
      confidence: 0.70,
      detectedBy: 'index.html',
    });
  }

  // Select highest confidence result
  signals.sort((a, b) => b.confidence - a.confidence);
  return signals[0] || { type: 'unknown', confidence: 0 };
}
```

### 4.2 Node.js Framework Detection

```typescript
function detectNodeFramework(pkg: PackageJson, files: string[]): DetectionSignal {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Framework config files take precedence
  const frameworkConfigs: Record<string, DetectionSignal> = {
    'next.config.js': { type: 'nextjs', framework: 'next', confidence: 0.95 },
    'next.config.mjs': { type: 'nextjs', framework: 'next', confidence: 0.95 },
    'next.config.ts': { type: 'nextjs', framework: 'next', confidence: 0.95 },
    'nuxt.config.js': { type: 'nuxt', framework: 'nuxt', confidence: 0.95 },
    'nuxt.config.ts': { type: 'nuxt', framework: 'nuxt', confidence: 0.95 },
    'svelte.config.js': { type: 'sveltekit', framework: 'sveltekit', confidence: 0.95 },
    'remix.config.js': { type: 'remix', framework: 'remix', confidence: 0.95 },
    'astro.config.mjs': { type: 'astro', framework: 'astro', confidence: 0.95 },
    'nest-cli.json': { type: 'node', framework: 'nest', confidence: 0.95 },
    'angular.json': { type: 'spa', framework: 'angular', confidence: 0.95 },
    'vite.config.js': { type: 'spa', framework: 'vite', confidence: 0.80 },
    'vite.config.ts': { type: 'spa', framework: 'vite', confidence: 0.80 },
  };

  for (const [file, result] of Object.entries(frameworkConfigs)) {
    if (files.includes(file)) {
      return { ...result, detectedBy: file };
    }
  }

  // Dependency-based detection
  const depDetection: Record<string, DetectionSignal> = {
    'next': { type: 'nextjs', framework: 'next', confidence: 0.85 },
    'nuxt': { type: 'nuxt', framework: 'nuxt', confidence: 0.85 },
    '@sveltejs/kit': { type: 'sveltekit', framework: 'sveltekit', confidence: 0.85 },
    '@remix-run/node': { type: 'remix', framework: 'remix', confidence: 0.85 },
    'astro': { type: 'astro', framework: 'astro', confidence: 0.85 },
    '@nestjs/core': { type: 'node', framework: 'nest', confidence: 0.85 },
    'express': { type: 'node', framework: 'express', confidence: 0.80 },
    'fastify': { type: 'node', framework: 'fastify', confidence: 0.80 },
    'hono': { type: 'node', framework: 'hono', confidence: 0.80 },
    'koa': { type: 'node', framework: 'koa', confidence: 0.80 },
    '@hapi/hapi': { type: 'node', framework: 'hapi', confidence: 0.80 },
  };

  for (const [dep, result] of Object.entries(depDetection)) {
    if (deps[dep]) {
      return { ...result, detectedBy: `${dep} dependency` };
    }
  }

  // Generic Node.js
  if (pkg.scripts?.start) {
    return {
      type: 'node',
      framework: 'generic',
      confidence: 0.75,
      detectedBy: 'package.json start script',
    };
  }

  // Static build output
  if (pkg.scripts?.build && !pkg.scripts?.start) {
    return {
      type: 'spa',
      framework: 'static-build',
      confidence: 0.70,
      detectedBy: 'package.json build script (no start)',
    };
  }

  return {
    type: 'node',
    framework: 'generic',
    confidence: 0.60,
    detectedBy: 'package.json presence',
  };
}
```

### 4.3 Entry Point Detection

```typescript
const ENTRY_POINT_CANDIDATES: Record<string, string[]> = {
  node: [
    'server.js', 'server.ts',
    'app.js', 'app.ts',
    'index.js', 'index.ts',
    'main.js', 'main.ts',
    'src/server.js', 'src/server.ts',
    'src/index.js', 'src/index.ts',
    'src/main.js', 'src/main.ts',
    'dist/server.js', 'dist/index.js', 'dist/main.js',
    'build/server.js', 'build/index.js',
  ],
  python: [
    'app.py', 'main.py', 'server.py',
    'wsgi.py', 'asgi.py',
    'src/app.py', 'src/main.py',
  ],
  go: [
    'main.go',
    'cmd/server/main.go',
    'cmd/api/main.go',
  ],
  rust: [
    'src/main.rs',
  ],
};

async function detectEntryPoint(
  appPath: string,
  type: AppType,
  pkg?: PackageJson
): Promise<string | null> {
  // Check package.json main/module first
  if (pkg?.main) return pkg.main;
  if (pkg?.module) return pkg.module;

  // Check start script for hints
  if (pkg?.scripts?.start) {
    const match = pkg.scripts.start.match(/node\s+(\S+\.js)/);
    if (match) return match[1];
  }

  // Check candidates
  const candidates = ENTRY_POINT_CANDIDATES[type] || [];
  for (const candidate of candidates) {
    if (await fs.pathExists(path.join(appPath, candidate))) {
      return candidate;
    }
  }

  return null;
}
```

### 4.4 Port Assignment

```typescript
class PortManager {
  private readonly basePort = 3000;
  private readonly maxPort = 9999;
  private readonly usedPorts = new Set<number>();

  async assignPort(appName: string): Promise<number> {
    // Generate deterministic port from app name
    const hash = crypto.createHash('md5').update(appName).digest('hex');
    let port = this.basePort + (parseInt(hash.slice(0, 4), 16) % (this.maxPort - this.basePort));

    // Find available port
    while (this.usedPorts.has(port) || !(await this.isPortAvailable(port))) {
      port++;
      if (port > this.maxPort) port = this.basePort;
    }

    this.usedPorts.add(port);
    return port;
  }

  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.on('listening', () => {
        server.close();
        resolve(true);
      });
      server.on('error', () => resolve(false));
    });
  }

  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }
}
```

---

## 5. Database Provisioning

### 5.1 SQLite (Default, Zero-Config)

**Location**: `/var/drop/data/db/{app-name}.db`

```typescript
class SQLiteProvisioner implements DatabaseProvisioner {
  async provision(appName: string, config?: DatabaseConfig): Promise<ProvisionedDatabase> {
    const dbName = config?.name || appName;
    const dbPath = path.join(this.dataDir, 'db', `${dbName}.db`);

    // Ensure directory exists
    await fs.ensureDir(path.dirname(dbPath));

    // Create empty database
    const db = new Database(dbPath);
    db.close();

    return {
      type: 'sqlite',
      name: dbName,
      host: 'localhost',
      port: 0,
      username: '',
      password: '',
      url: `file:${dbPath}`,
      path: dbPath,
    };
  }

  async deprovision(appName: string): Promise<void> {
    const dbPath = path.join(this.dataDir, 'db', `${appName}.db`);
    const backupPath = path.join(this.dataDir, 'backup', appName, `final-${Date.now()}.db`);

    // Create final backup before removal
    await fs.ensureDir(path.dirname(backupPath));
    await fs.copy(dbPath, backupPath);
    await fs.remove(dbPath);
  }
}
```

**Environment Variables Injected**:
```bash
DATABASE_URL=file:/var/drop/data/db/my-app.db
DATABASE_PATH=/var/drop/data/db/my-app.db
DATABASE_TYPE=sqlite
```

### 5.2 PostgreSQL (Plugin)

```typescript
class PostgreSQLProvisioner implements DatabaseProvisioner {
  async provision(appName: string, config?: DatabaseConfig): Promise<ProvisionedDatabase> {
    const dbName = this.sanitizeName(config?.name || appName);
    const username = `drop_${dbName}`;
    const password = this.generatePassword();

    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${username}') THEN
          CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password}';
        END IF;
      END $$;
    `);

    await this.pool.query(`
      CREATE DATABASE "${dbName}"
      OWNER "${username}"
      ENCODING 'UTF8'
      LC_COLLATE 'en_US.UTF-8'
      LC_CTYPE 'en_US.UTF-8'
    `);

    return {
      type: 'postgresql',
      name: dbName,
      host: this.config.host || 'localhost',
      port: this.config.port || 5432,
      username,
      password,
      url: `postgresql://${username}:${password}@${this.config.host}:${this.config.port}/${dbName}`,
    };
  }

  private sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
  }

  private generatePassword(): string {
    return crypto.randomBytes(24).toString('base64url');
  }
}
```

### 5.3 PostgreSQL Lifecycle Management

DROP can optionally manage the full PostgreSQL lifecycle (installation, initialization, version management).

```typescript
interface PostgreSQLLifecycleConfig {
  managed: boolean;                      // DROP manages PostgreSQL lifecycle
  version: string;                       // PostgreSQL version (e.g., "16")
  dataDir: string;                       // Data directory
  port: number;                          // Default: 5461
  walArchiving: boolean;                 // Enable WAL archiving
  maxConnections: number;                // Default: 100
}

class PostgreSQLLifecycleManager {
  private config: PostgreSQLLifecycleConfig;
  private process: ChildProcess | null = null;

  async initialize(): Promise<void> {
    // Check if data directory exists
    if (!await this.isInitialized()) {
      await this.initDatabase();
    }

    // Start PostgreSQL
    await this.start();

    // Configure replication if needed
    if (this.config.walArchiving) {
      await this.configureWALArchiving();
    }
  }

  private async initDatabase(): Promise<void> {
    const initdbPath = this.getBinaryPath('initdb');

    await execa(initdbPath, [
      '-D', this.config.dataDir,
      '-E', 'UTF8',
      '--locale', 'en_US.UTF-8',
      '-U', 'drop_admin',
    ]);

    // Write postgresql.conf
    await this.writeConfig();
  }

  private async writeConfig(): Promise<void> {
    const config = `
# DROP PostgreSQL Configuration
listen_addresses = 'localhost'
port = ${this.config.port}
max_connections = ${this.config.maxConnections}

# WAL Configuration
wal_level = ${this.config.walArchiving ? 'replica' : 'minimal'}
archive_mode = ${this.config.walArchiving ? 'on' : 'off'}
archive_command = '${this.getArchiveCommand()}'

# Logging
logging_collector = on
log_directory = '/var/drop/data/logs/postgresql'
log_filename = 'postgresql-%Y-%m-%d.log'
log_rotation_age = 1d
log_rotation_size = 100MB

# Performance
shared_buffers = 256MB
effective_cache_size = 768MB
maintenance_work_mem = 64MB
work_mem = 4MB
`;
    await fs.writeFile(
      path.join(this.config.dataDir, 'postgresql.conf'),
      config
    );
  }

  async start(): Promise<void> {
    const pgCtlPath = this.getBinaryPath('pg_ctl');

    await execa(pgCtlPath, [
      '-D', this.config.dataDir,
      '-l', '/var/drop/data/logs/postgresql/startup.log',
      'start',
    ]);

    // Wait for startup
    await this.waitForStartup();
  }

  async stop(): Promise<void> {
    const pgCtlPath = this.getBinaryPath('pg_ctl');

    await execa(pgCtlPath, [
      '-D', this.config.dataDir,
      '-m', 'fast',
      'stop',
    ]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // Version management
  async getVersion(): Promise<string> {
    const versionFile = path.join(this.config.dataDir, 'PG_VERSION');
    return (await fs.readFile(versionFile, 'utf-8')).trim();
  }

  async upgrade(targetVersion: string): Promise<void> {
    const currentVersion = await this.getVersion();

    if (currentVersion === targetVersion) {
      return; // Already at target version
    }

    // Backup before upgrade
    await this.createBinaryBackup();

    // Stop current PostgreSQL
    await this.stop();

    // Run pg_upgrade
    const pgUpgradePath = this.getBinaryPath('pg_upgrade', targetVersion);
    await execa(pgUpgradePath, [
      '-b', this.getBinDir(currentVersion),
      '-B', this.getBinDir(targetVersion),
      '-d', this.config.dataDir,
      '-D', `${this.config.dataDir}_new`,
    ]);

    // Swap directories
    await fs.rename(this.config.dataDir, `${this.config.dataDir}_old`);
    await fs.rename(`${this.config.dataDir}_new`, this.config.dataDir);

    // Start new version
    await this.start();
  }

  // WAL archiving
  private async configureWALArchiving(): Promise<void> {
    const archiveDir = '/var/drop/data/drop-svc/wal_archive';
    await fs.ensureDir(archiveDir);
  }

  private getArchiveCommand(): string {
    return `cp %p /var/drop/data/drop-svc/wal_archive/%f`;
  }
}
```

### 5.4 Backup Strategy

DROP provides comprehensive, configurable database backups with retention policies.

**Backup Configuration** (`/var/drop/data/appconf/drop.yaml`):
```yaml
backup:
  enabled: true
  initialDelay: 60                       # Minutes after startup (1-6000)
  interval: 360                          # Backup interval in minutes (1-6000)
  compression: true                      # GZIP compression
  compressionLevel: 6                    # GZIP level (1-9)
  retention: 30                          # Number of backups to keep (1-100)

  # Per-app overrides
  apps:
    critical-app:
      interval: 60                       # More frequent backups
      retention: 100                     # Keep more backups
```

```typescript
interface BackupConfig {
  enabled: boolean;
  initialDelay: number;                  // Minutes (1-6000)
  interval: number;                      // Minutes (1-6000)
  compression: boolean;
  compressionLevel: number;              // 1-9
  retention: number;                     // Number of backups (1-100)
}

class BackupManager {
  private config: BackupConfig;
  private timer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    // Initial delay before first backup
    setTimeout(async () => {
      await this.runBackups();

      // Schedule recurring backups
      this.timer = setInterval(
        () => this.runBackups(),
        this.config.interval * 60 * 1000
      );
    }, this.config.initialDelay * 60 * 1000);
  }

  async runBackups(): Promise<BackupResult[]> {
    const results: BackupResult[] = [];
    const apps = await this.registry.getAllApps();

    for (const app of apps) {
      if (app.database) {
        try {
          const result = await this.createBackup(app.name, app.database.type);
          results.push(result);
        } catch (error) {
          this.logger.error(`Backup failed for ${app.name}:`, error);
          results.push({ appName: app.name, success: false, error: error.message });
        }
      }
    }

    return results;
  }

  async createBackup(appName: string, type: DatabaseType): Promise<BackupResult> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.dataDir, 'backup', appName);
    const extension = this.config.compression ? '.backup.gz' : '.backup';
    const backupPath = path.join(backupDir, `${timestamp}${extension}`);

    await fs.ensureDir(backupDir);

    const startTime = Date.now();

    switch (type) {
      case 'sqlite':
        await this.backupSQLite(appName, backupPath);
        break;
      case 'postgresql':
        await this.backupPostgreSQL(appName, backupPath);
        break;
    }

    // Cleanup old backups based on retention policy
    await this.enforceRetention(backupDir);

    const stats = await fs.stat(backupPath);

    return {
      appName,
      success: true,
      path: backupPath,
      size: stats.size,
      duration: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  private async backupSQLite(appName: string, backupPath: string): Promise<void> {
    const dbPath = path.join(this.dataDir, 'db', `${appName}.db`);
    const db = new Database(dbPath);

    if (this.config.compression) {
      // Backup to temp file, then compress
      const tempPath = `${backupPath}.tmp`;
      await db.backup(tempPath);
      db.close();

      await this.compressFile(tempPath, backupPath);
      await fs.remove(tempPath);
    } else {
      await db.backup(backupPath);
      db.close();
    }
  }

  private async backupPostgreSQL(appName: string, backupPath: string): Promise<void> {
    const dumpArgs = [
      '-h', this.pgConfig.host,
      '-p', String(this.pgConfig.port),
      '-U', this.pgConfig.superuser,
      '-Fc',                             // Custom format (already compressed)
      '-f', backupPath.replace('.gz', ''),
      appName,
    ];

    await execa('pg_dump', dumpArgs, {
      env: { PGPASSWORD: this.pgConfig.password },
    });

    // PostgreSQL custom format is already compressed, but apply GZIP if requested
    if (this.config.compression && !backupPath.endsWith('.gz')) {
      await this.compressFile(backupPath, `${backupPath}.gz`);
      await fs.remove(backupPath);
    }
  }

  private async compressFile(input: string, output: string): Promise<void> {
    const gzip = zlib.createGzip({ level: this.config.compressionLevel });
    const source = createReadStream(input);
    const destination = createWriteStream(output);

    await pipeline(source, gzip, destination);
  }

  private async enforceRetention(backupDir: string): Promise<void> {
    const files = await fs.readdir(backupDir);
    const backupFiles = files
      .filter(f => f.endsWith('.backup') || f.endsWith('.backup.gz'))
      .sort()
      .reverse();

    // Delete backups beyond retention limit
    const toDelete = backupFiles.slice(this.config.retention);
    for (const file of toDelete) {
      await fs.remove(path.join(backupDir, file));
      this.logger.info(`Deleted old backup: ${file}`);
    }
  }

  // Restore from backup
  async restore(appName: string, backupFile: string): Promise<void> {
    const backupPath = path.join(this.dataDir, 'backup', appName, backupFile);
    const dbType = await this.getDatabaseType(appName);

    // Stop the app during restore
    await this.processManager.stop(appName);

    try {
      switch (dbType) {
        case 'sqlite':
          await this.restoreSQLite(appName, backupPath);
          break;
        case 'postgresql':
          await this.restorePostgreSQL(appName, backupPath);
          break;
      }
    } finally {
      // Restart the app
      await this.processManager.start(appName);
    }
  }

  // List available backups
  async listBackups(appName: string): Promise<BackupInfo[]> {
    const backupDir = path.join(this.dataDir, 'backup', appName);

    if (!await fs.pathExists(backupDir)) {
      return [];
    }

    const files = await fs.readdir(backupDir);
    const backups: BackupInfo[] = [];

    for (const file of files) {
      if (file.endsWith('.backup') || file.endsWith('.backup.gz')) {
        const filePath = path.join(backupDir, file);
        const stats = await fs.stat(filePath);
        backups.push({
          filename: file,
          size: stats.size,
          createdAt: stats.mtime,
          compressed: file.endsWith('.gz'),
        });
      }
    }

    return backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

interface BackupResult {
  appName: string;
  success: boolean;
  path?: string;
  size?: number;
  duration?: number;
  timestamp?: Date;
  error?: string;
}

interface BackupInfo {
  filename: string;
  size: number;
  createdAt: Date;
  compressed: boolean;
}
```

**CLI Commands for Backups**:
```bash
drop backup create <app>                 # Create immediate backup
drop backup list <app>                   # List available backups
drop backup restore <app> <filename>     # Restore from backup
drop backup config                       # Show backup configuration
```

---

## 6. Reverse Proxy & SSL

### 6.1 Caddy Integration

**Why Caddy**:
- Automatic HTTPS via Let's Encrypt / ZeroSSL
- HTTP/2 and HTTP/3 support out of the box
- Simple, declarative configuration
- Dynamic configuration via Admin API
- Built-in load balancing
- Automatic certificate renewal

### 6.2 Base Caddyfile

**Location**: `/etc/caddy/Caddyfile`

```caddyfile
{
  admin localhost:2019
  email {$DROP_ADMIN_EMAIL:admin@localhost}

  # Global options
  servers {
    protocols h1 h2 h2c h3
  }

  # Logging
  log {
    output file /var/drop/data/logs/caddy/access.log {
      roll_size 100mb
      roll_keep 10
    }
    format json
  }
}

# Import all app configurations
import /var/drop/data/appconf/caddy/webapps/*.caddy
import /var/drop/data/appconf/caddy/hosts/*.caddy
```

### 6.3 Per-App Caddy Configuration

**Generated at**: `/var/drop/data/appconf/caddy/webapps/{app-name}.caddy`

```caddyfile
# Generated by DROP for: my-app
# Type: node/express
# Updated: 2025-01-15T10:30:00Z

my-app.{$DROP_DOMAIN:drop.local} {
  reverse_proxy localhost:3001 {
    # Health checking
    health_uri /health
    health_interval 30s
    health_timeout 5s
    health_status 2xx

    # Load balancing (when clustered)
    lb_policy round_robin
    lb_try_duration 5s
    lb_try_interval 250ms

    # Headers
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Request-ID {uuid}

    # Timeouts
    transport http {
      dial_timeout 5s
      response_header_timeout 30s
      read_timeout 60s
      write_timeout 60s
    }
  }

  # Response headers
  header {
    X-Powered-By "DROP"
    X-Frame-Options "SAMEORIGIN"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  # Compression
  encode zstd gzip

  # Logging
  log {
    output file /var/drop/data/logs/webapps/my-app/access.log {
      roll_size 50mb
      roll_keep 5
    }
    format json
  }
}
```

### 6.4 Hostname-Based Routing

**Generated at**: `/var/drop/data/appconf/caddy/hosts/{hostname}.caddy`

```caddyfile
# Generated by DROP for hostname: api.example.com
# Updated: 2025-01-15T10:30:00Z

api.example.com {
  # Context path: /v1 -> app: api-v1 (port 3001)
  handle /v1/* {
    reverse_proxy localhost:3001 {
      health_uri /health
      health_interval 30s
    }
  }

  # Context path: /v2 -> app: api-v2 (port 3002)
  handle /v2/* {
    reverse_proxy localhost:3002 {
      health_uri /health
      health_interval 30s
    }
  }

  # Root context -> app: api-root (port 3003)
  handle {
    reverse_proxy localhost:3003 {
      health_uri /health
      health_interval 30s
    }
  }

  encode zstd gzip
}

# Alias: api.example.org -> api.example.com
api.example.org {
  redir https://api.example.com{uri} permanent
}
```

### 6.5 Static Site Configuration

```caddyfile
# Generated by DROP for: portfolio (static site)

portfolio.{$DROP_DOMAIN:drop.local} {
  root * /var/drop/data/webapps/portfolio

  # SPA fallback
  try_files {path} {path}/ /index.html

  file_server {
    precompressed gzip br
  }

  # Cache static assets
  @static {
    path *.js *.css *.png *.jpg *.jpeg *.gif *.ico *.svg *.woff *.woff2
  }
  header @static Cache-Control "public, max-age=31536000, immutable"

  # Security headers
  header {
    X-Frame-Options "SAMEORIGIN"
    X-Content-Type-Options "nosniff"
    -Server
  }

  encode zstd gzip
}
```

### 6.6 Caddy API Integration

```typescript
class CaddyManager {
  private readonly adminUrl = 'http://localhost:2019';

  async updateAppConfig(appName: string, config: CaddyAppConfig): Promise<void> {
    const caddyConfig = this.generateCaddyConfig(appName, config);
    const configPath = path.join(this.configDir, 'apps', `${appName}.caddy`);

    await fs.writeFile(configPath, caddyConfig);
    await this.reloadConfig();
  }

  async updateHostConfig(hostname: string, apps: HostApp[]): Promise<void> {
    const caddyConfig = this.generateHostConfig(hostname, apps);
    const configPath = path.join(this.configDir, 'hosts', `${hostname}.caddy`);

    await fs.writeFile(configPath, caddyConfig);
    await this.reloadConfig();
  }

  async reloadConfig(): Promise<void> {
    // Build complete config from imports
    const mainConfig = await this.buildMainConfig();

    // POST to Caddy admin API
    const response = await fetch(`${this.adminUrl}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mainConfig),
    });

    if (!response.ok) {
      throw new Error(`Failed to reload Caddy: ${await response.text()}`);
    }
  }

  async removeApp(appName: string): Promise<void> {
    const configPath = path.join(this.configDir, 'apps', `${appName}.caddy`);
    await fs.remove(configPath);
    await this.reloadConfig();
  }

  async getStatus(): Promise<CaddyStatus> {
    const response = await fetch(`${this.adminUrl}/config/`);
    return response.json();
  }
}
```

### 6.7 ACME Challenge Handling

DROP handles ACME HTTP-01 challenges automatically:

```typescript
class AcmeChallengeHandler {
  private challenges = new Map<string, string>();

  addChallenge(token: string, keyAuth: string): void {
    this.challenges.set(token, keyAuth);
  }

  removeChallenge(token: string): void {
    this.challenges.delete(token);
  }

  getChallenge(token: string): string | undefined {
    return this.challenges.get(token);
  }
}

// Caddy handles this automatically, but for custom setups:
// Route: /.well-known/acme-challenge/{token}
```

### 6.8 Custom Domain Management

```typescript
interface CustomDomain {
  domain: string;
  appName: string;
  verified: boolean;
  sslEnabled: boolean;
  verificationRecord?: string;
}

class DomainManager {
  async addCustomDomain(appName: string, domain: string): Promise<CustomDomain> {
    // Generate verification TXT record
    const verificationRecord = `drop-verify=${crypto.randomBytes(16).toString('hex')}`;

    const customDomain: CustomDomain = {
      domain,
      appName,
      verified: false,
      sslEnabled: false,
      verificationRecord,
    };

    await this.registry.addCustomDomain(customDomain);
    return customDomain;
  }

  async verifyDomain(domain: string): Promise<boolean> {
    const customDomain = await this.registry.getCustomDomain(domain);
    if (!customDomain) return false;

    // Check DNS TXT record
    const records = await dns.resolveTxt(domain);
    const verified = records.some(r =>
      r.join('').includes(customDomain.verificationRecord)
    );

    if (verified) {
      await this.registry.updateCustomDomain(domain, { verified: true });
      await this.updateCaddyConfig(customDomain.appName);
    }

    return verified;
  }
}
```

### 6.9 Hot TLS Certificate Reload

DROP supports hot-reloading TLS certificates without server restart, useful for certificate rotation and renewal.

```typescript
interface TLSConfig {
  keyFile: string;                       // Path to private key
  certFile: string;                      // Path to certificate
  caFile?: string;                       // Optional CA bundle
  watchInterval: number;                 // File watch interval (ms)
}

class TLSCertificateManager {
  private watcher: FSWatcher | null = null;
  private currentCert: { key: Buffer; cert: Buffer } | null = null;

  async initialize(config: TLSConfig): Promise<void> {
    // Load initial certificates
    await this.loadCertificates(config);

    // Watch for certificate changes
    this.startWatcher(config);
  }

  private async loadCertificates(config: TLSConfig): Promise<void> {
    const key = await fs.readFile(config.keyFile);
    const cert = await fs.readFile(config.certFile);

    this.currentCert = { key, cert };
    this.logger.info('TLS certificates loaded');
  }

  private startWatcher(config: TLSConfig): void {
    // Watch certificate files for changes
    this.watcher = chokidar.watch([config.keyFile, config.certFile], {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
    });

    this.watcher.on('change', async (path) => {
      this.logger.info(`Certificate file changed: ${path}`);
      await this.reloadCertificates(config);
    });
  }

  private async reloadCertificates(config: TLSConfig): Promise<void> {
    try {
      // Load new certificates
      const key = await fs.readFile(config.keyFile);
      const cert = await fs.readFile(config.certFile);

      // Validate certificates before applying
      if (!this.validateCertificate(cert, key)) {
        throw new Error('Invalid certificate or key');
      }

      // Update current certificates
      this.currentCert = { key, cert };

      // Notify Caddy to reload via admin API
      await this.notifyCaddyReload();

      this.logger.info('TLS certificates reloaded successfully');
      this.emit('certificate:reloaded');
    } catch (error) {
      this.logger.error('Failed to reload certificates:', error);
      this.emit('certificate:error', error);
    }
  }

  private validateCertificate(cert: Buffer, key: Buffer): boolean {
    try {
      // Parse and validate certificate
      const certPem = cert.toString();
      const keyPem = key.toString();

      // Check certificate expiry
      const x509 = crypto.createPublicKey(certPem);
      const certInfo = crypto.X509Certificate?.create?.(certPem);

      if (certInfo) {
        const validTo = new Date(certInfo.validTo);
        if (validTo < new Date()) {
          this.logger.error('Certificate has expired');
          return false;
        }

        // Warn if expiring soon (within 30 days)
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        if (validTo.getTime() - Date.now() < thirtyDays) {
          this.logger.warn('Certificate expiring within 30 days');
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private async notifyCaddyReload(): Promise<void> {
    // Caddy handles certificate reload automatically when using its
    // certificate storage. For custom certificates, trigger reload:
    await fetch('http://localhost:2019/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await this.buildCaddyConfig()),
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
```

### 6.10 Per-Host HTTPS Redirect Configuration

DROP supports fine-grained HTTPS redirect configuration per hostname.

```typescript
interface HostHTTPSConfig {
  hostname: string;
  httpsRedirect: boolean;                // Enable/disable HTTPS redirect
  httpsRedirectPort: number;             // Redirect to port (default: 443)
  allowLocalhost: boolean;               // Skip redirect for localhost
  allowAcmeChallenge: boolean;           // Allow /.well-known/acme-challenge/
  hsts: HSTSConfig | null;               // HTTP Strict Transport Security
}

interface HSTSConfig {
  maxAge: number;                        // Seconds (default: 31536000 = 1 year)
  includeSubDomains: boolean;
  preload: boolean;
}

class HTTPSRedirectManager {
  private configs: Map<string, HostHTTPSConfig> = new Map();

  // Default configuration
  private defaultConfig: HostHTTPSConfig = {
    hostname: '*',
    httpsRedirect: true,
    httpsRedirectPort: 443,
    allowLocalhost: true,
    allowAcmeChallenge: true,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: false,
      preload: false,
    },
  };

  async setHostConfig(hostname: string, config: Partial<HostHTTPSConfig>): Promise<void> {
    const merged = { ...this.defaultConfig, ...config, hostname };
    this.configs.set(hostname, merged);

    // Update Caddy configuration
    await this.updateCaddyConfig(hostname);
  }

  async getHostConfig(hostname: string): Promise<HostHTTPSConfig> {
    return this.configs.get(hostname) || this.defaultConfig;
  }

  // Generate Caddy config for HTTPS redirect
  generateCaddyHTTPSConfig(config: HostHTTPSConfig): string {
    if (!config.httpsRedirect) {
      return '';
    }

    const redirectPort = config.httpsRedirectPort !== 443
      ? `:${config.httpsRedirectPort}`
      : '';

    return `
# HTTP -> HTTPS redirect for ${config.hostname}
http://${config.hostname} {
  ${config.allowAcmeChallenge ? `
  # Allow ACME challenges
  @acme path /.well-known/acme-challenge/*
  handle @acme {
    file_server
  }
  ` : ''}

  ${config.allowLocalhost ? `
  # Skip redirect for localhost
  @localhost remote_ip 127.0.0.1 ::1
  handle @localhost {
    reverse_proxy {upstream}
  }
  ` : ''}

  # Redirect all other requests to HTTPS
  handle {
    redir https://{host}${redirectPort}{uri} permanent
  }
}

${config.hsts ? `
# HSTS headers for ${config.hostname}
https://${config.hostname} {
  header Strict-Transport-Security "max-age=${config.hsts.maxAge}${
    config.hsts.includeSubDomains ? '; includeSubDomains' : ''
  }${config.hsts.preload ? '; preload' : ''}"
}
` : ''}
`;
  }

  private async updateCaddyConfig(hostname: string): Promise<void> {
    const config = this.configs.get(hostname);
    if (!config) return;

    const caddyConfig = this.generateCaddyHTTPSConfig(config);
    const configPath = `/var/drop/data/appconf/caddy/hosts/${hostname}.https.caddy`;

    await fs.writeFile(configPath, caddyConfig);
    await this.caddyManager.reloadConfig();
  }
}
```

**Per-Host Configuration File** (`{hostname}.conf`):
```properties
# /var/drop/data/webapps/api.example.com/api.example.com.conf
https.redirect=true
https.redirect.port=443
https.redirect.localhost=false
https.hsts.enabled=true
https.hsts.maxAge=31536000
https.hsts.includeSubDomains=true
https.hsts.preload=false
```

**CLI Commands**:
```bash
drop domain https api.example.com --enable          # Enable HTTPS redirect
drop domain https api.example.com --disable         # Disable HTTPS redirect
drop domain https api.example.com --hsts            # Enable HSTS
drop domain https api.example.com --no-localhost    # Redirect localhost too
```

### 6.11 Static File Serving from Host Directories

DROP can serve static files directly from host directories without requiring a running application, useful for static assets, maintenance pages, or simple static sites within a hostname-based deployment.

```typescript
interface StaticFileConfig {
  enabled: boolean;                      // Enable static file serving
  rootDir: string;                       // Root directory for static files
  indexFiles: string[];                  // Default: ['index.html', 'index.htm']
  cacheControl: string;                  // Default: 'max-age=600'
  fallbackToApp: boolean;                // Try app if static file not found
}

class StaticFileServer {
  private mimeTypes: Map<string, string>;

  async tryServeStaticFile(
    req: Request,
    res: Response,
    hostDirectory: string
  ): Promise<boolean> {
    let requestedPath = req.path;

    // Normalize path
    while (requestedPath.startsWith('/')) {
      requestedPath = requestedPath.substring(1);
    }

    // Append index.html for directory requests
    if (requestedPath.endsWith('/')) {
      requestedPath = requestedPath + 'index.html';
    }

    // Resolve file path
    let filePath: string;

    if (requestedPath === '') {
      // Root request -> ROOT/index.html
      filePath = path.join(hostDirectory, 'ROOT', 'index.html');
    } else if (!requestedPath.includes('/')) {
      // Single segment - check if it's a context path or file
      const possibleDir = path.join(hostDirectory, requestedPath);

      if (await this.isDirectory(possibleDir)) {
        // It's a context path directory, redirect to add trailing slash
        res.redirect(301, req.path + '/');
        return true;
      }

      // Try ROOT directory
      filePath = path.join(hostDirectory, 'ROOT', requestedPath);
    } else {
      // Multi-segment path
      const firstSegment = requestedPath.split('/')[0];
      const contextDir = path.join(hostDirectory, firstSegment);

      if (await this.isDirectory(contextDir)) {
        // Context path exists, serve from there
        filePath = path.join(hostDirectory, requestedPath);
      } else {
        // Serve from ROOT
        filePath = path.join(hostDirectory, 'ROOT', requestedPath);
      }
    }

    // Security: Prevent path traversal
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(hostDirectory))) {
      return false;
    }

    // Check if file exists
    if (!await this.isFile(resolvedPath)) {
      return false;
    }

    // Determine MIME type
    const mimeType = this.getMimeType(resolvedPath) || 'application/octet-stream';

    // Serve the file
    const stats = await fs.stat(resolvedPath);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'max-age=600');

    const stream = createReadStream(resolvedPath);
    stream.pipe(res);

    return true;
  }

  private getMimeType(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.mimeTypes.get(ext);
  }
}
```

**Use Cases**:
- Serve static assets (CSS, JS, images) without proxying to app
- Maintenance pages when app is down
- Mixed static/dynamic hosting within same hostname
- Fast serving of pre-built SPA assets

### 6.12 TLS Protocol Configuration

DROP supports fine-grained configuration of TLS/SSL protocols for security compliance.

```typescript
interface TLSProtocolConfig {
  // Protocols to explicitly enable (prefix with +)
  // Protocols to explicitly disable (prefix with -)
  // Example: ['+TLSv1.3', '-TLSv1.0', '-TLSv1.1']
  protocols: string[];
}

class TLSProtocolManager {
  private defaultEnabled = ['TLSv1.2', 'TLSv1.3'];
  private defaultDisabled = ['SSLv3', 'TLSv1.0', 'TLSv1.1'];

  parseProtocolConfig(configString: string): TLSProtocolConfig {
    const protocols: string[] = [];

    if (!configString || configString.trim() === '') {
      return { protocols: [] };
    }

    const parts = configString.split(',').map(s => s.trim());

    for (const part of parts) {
      if (part.startsWith('+') && part.length > 1) {
        protocols.push(part);  // Enable protocol
      } else if (part.startsWith('-') && part.length > 1) {
        protocols.push(part);  // Disable protocol
      } else {
        throw new Error(
          `Invalid TLS protocol configuration: "${part}". ` +
          `Must start with '+' (enable) or '-' (disable).`
        );
      }
    }

    return { protocols };
  }

  applyProtocolConfig(config: TLSProtocolConfig): { include: string[], exclude: string[] } {
    const include = [...this.defaultEnabled];
    const exclude = [...this.defaultDisabled];

    for (const protocol of config.protocols) {
      const name = protocol.substring(1);

      if (protocol.startsWith('+')) {
        // Enable: add to include, remove from exclude
        if (!include.includes(name)) {
          include.push(name);
        }
        const excludeIdx = exclude.indexOf(name);
        if (excludeIdx >= 0) {
          exclude.splice(excludeIdx, 1);
        }
      } else if (protocol.startsWith('-')) {
        // Disable: add to exclude, remove from include
        if (!exclude.includes(name)) {
          exclude.push(name);
        }
        const includeIdx = include.indexOf(name);
        if (includeIdx >= 0) {
          include.splice(includeIdx, 1);
        }
      }
    }

    return { include, exclude };
  }
}
```

**Configuration** (`/var/drop/data/appconf/drop.yaml`):
```yaml
tls:
  # Configure TLS protocols
  # Use + to enable, - to disable
  # Example: Enable TLSv1.3 only, disable older protocols
  protocols: "+TLSv1.3, -TLSv1.2, -TLSv1.1, -TLSv1.0"

  # Cipher suites (optional)
  ciphers:
    - "TLS_AES_256_GCM_SHA384"
    - "TLS_CHACHA20_POLY1305_SHA256"
    - "TLS_AES_128_GCM_SHA256"

  # Minimum TLS version (alternative to protocols)
  minVersion: "1.2"
```

**Per-Host TLS Configuration** (`{hostname}.conf`):
```properties
# /var/drop/data/webapps/secure.example.com/secure.example.com.conf
tls.protocols=+TLSv1.3,-TLSv1.2
tls.minVersion=1.3
```

**CLI Commands**:
```bash
drop tls protocols                       # Show current TLS protocol config
drop tls protocols +TLSv1.3 -TLSv1.0     # Configure protocols
drop tls test api.example.com            # Test TLS configuration
```

---

## 7. API Specification

### 7.1 Overview

**Base URL**: `http://localhost:9000/api/v1`
**Authentication**: API Key via `Authorization: Bearer <key>` header or `X-API-Key` header

### 7.2 Core Endpoints

#### Apps

```yaml
# List all applications
GET /apps
Query: ?status=running&type=node&tenant=tenant_id
Response: { apps: App[], total: number, page: number }

# Get single app
GET /apps/:name
Response: { app: App }

# Create app (from upload or git)
POST /apps
Body: { name: string, git?: string, template?: string }
Response: { app: App, deployment: Deployment }

# Update app configuration
PUT /apps/:name
Body: Partial<AppConfig>
Response: { app: App }

# Delete app
DELETE /apps/:name
Query: ?keepData=true&keepBackups=true
Response: { success: true }

# App actions
POST /apps/:name/deploy      # Trigger deployment
POST /apps/:name/start       # Start app
POST /apps/:name/stop        # Stop app
POST /apps/:name/restart     # Restart app
POST /apps/:name/rebuild     # Force rebuild
POST /apps/:name/scale       # Scale instances
Body: { instances: number }

# App resources
GET  /apps/:name/logs        # Get logs
Query: ?lines=100&follow=false&level=info
GET  /apps/:name/status      # Get status
GET  /apps/:name/metrics     # Get metrics
GET  /apps/:name/env         # Get env vars
PUT  /apps/:name/env         # Update env vars
GET  /apps/:name/secrets     # List secrets
POST /apps/:name/secrets     # Add secret
DELETE /apps/:name/secrets/:key  # Remove secret
```

#### Deployments

```yaml
GET    /apps/:name/deployments           # List deployments
GET    /apps/:name/deployments/:id       # Get deployment
GET    /apps/:name/deployments/:id/logs  # Get build logs
POST   /apps/:name/deployments/:id/rollback  # Rollback
```

#### Domains

```yaml
GET    /apps/:name/domains               # List domains
POST   /apps/:name/domains               # Add domain
DELETE /apps/:name/domains/:domain       # Remove domain
POST   /apps/:name/domains/:domain/verify  # Verify domain
```

#### Databases

```yaml
GET    /apps/:name/database              # Get database info
POST   /apps/:name/database/backup       # Create backup
GET    /apps/:name/database/backups      # List backups
POST   /apps/:name/database/restore      # Restore backup
```

#### System

```yaml
GET    /system/status        # Health check
GET    /system/info          # System info
GET    /system/metrics       # System metrics
GET    /system/config        # Platform config
PUT    /system/config        # Update config
```

### 7.3 Response Format

**Success Response**:
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2025-01-15T10:30:00Z",
    "requestId": "req_abc123",
    "duration": 45
  }
}
```

**Error Response**:
```json
{
  "success": false,
  "error": {
    "code": "APP_NOT_FOUND",
    "message": "Application 'my-app' not found",
    "details": { ... }
  },
  "meta": {
    "timestamp": "2025-01-15T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

### 7.4 WebSocket API

**Endpoint**: `ws://localhost:9000/ws`

**Events**:
```typescript
// Client -> Server
{ type: 'subscribe', channels: ['app:my-app', 'system'] }
{ type: 'unsubscribe', channels: ['app:my-app'] }

// Server -> Client
{ type: 'app:status', app: 'my-app', status: 'running', timestamp: '...' }
{ type: 'deployment:progress', app: 'my-app', deploymentId: '...', step: 'building', progress: 50 }
{ type: 'deployment:log', app: 'my-app', deploymentId: '...', message: '...', level: 'info' }
{ type: 'log', app: 'my-app', message: '...', level: 'info', timestamp: '...' }
{ type: 'metrics', app: 'my-app', cpu: 5.2, memory: 128000000, timestamp: '...' }
```

---

## 8. CLI Specification

### 8.1 Installation

```bash
# Global install
npm install -g @drop/cli

# Or via npx
npx @drop/cli <command>

# Or download binary
curl -fsSL https://drop.dev/install.sh | sh
```

### 8.2 Command Reference

```bash
# Initialize DROP
drop init                           # Initialize on server
drop init --domain example.com      # Set custom domain
drop login                          # Authenticate with remote DROP

# App Lifecycle
drop list                           # List all apps
drop list --status running          # Filter by status
drop deploy [path]                  # Deploy from directory
drop deploy --git <url>             # Deploy from git
drop deploy --git <url> --branch dev  # Specific branch
drop status <app>                   # Show app status
drop logs <app>                     # View logs
drop logs <app> -f                  # Follow logs
drop logs <app> --lines 500         # Last N lines
drop start <app>                    # Start app
drop stop <app>                     # Stop app
drop restart <app>                  # Restart app
drop scale <app> --instances 3      # Scale app
drop remove <app>                   # Remove app
drop remove <app> --keep-data       # Keep data/backups

# Configuration
drop config <app>                   # View config
drop config <app> get <key>         # Get config value
drop config <app> set <key> <val>   # Set config value
drop env <app>                      # View env vars
drop env <app> set KEY=value        # Set env var
drop env <app> unset KEY            # Remove env var

# Secrets
drop secrets <app>                  # List secrets
drop secrets <app> set <key>        # Set secret (prompts)
drop secrets <app> set <key> <val>  # Set secret directly
drop secrets <app> unset <key>      # Remove secret

# Domains
drop domains <app>                  # List domains
drop domains <app> add <domain>     # Add domain
drop domains <app> remove <domain>  # Remove domain
drop domains <app> verify <domain>  # Verify domain

# Database
drop db <app>                       # Database info
drop db <app> url                   # Print connection URL
drop db <app> backup                # Create backup
drop db <app> backups               # List backups
drop db <app> restore <backup>      # Restore backup
drop db <app> shell                 # Open database shell

# System
drop system status                  # System health
drop system info                    # System info
drop system update                  # Update DROP
drop system logs                    # View system logs

# Development
drop dev [path]                     # Run locally with DROP env
drop tunnel <app>                   # Create public tunnel
drop create <name>                  # Create from template
drop create <name> --template next  # Specific template
```

### 8.3 CLI Output Formatting

```bash
$ drop list

 NAME          TYPE      STATUS    PORT   URL
─────────────────────────────────────────────────────────────
 my-api        node      running   3001   https://my-api.drop.local
 portfolio     static    running   -      https://portfolio.drop.local
 dashboard     nextjs    stopped   3002   https://dashboard.drop.local

$ drop status my-api

 App: my-api
 Status: running
 Type: node (express)
 Port: 3001
 URL: https://my-api.drop.local

 Resources:
   Memory: 128 MB / 256 MB
   CPU: 2.3%
   Instances: 1

 Uptime: 3d 14h 22m
 Restarts: 0
 Last Deploy: 2025-01-12 14:30:00

$ drop logs my-api

2025-01-15 10:30:00 [INFO] Server started on port 3001
2025-01-15 10:30:01 [INFO] Connected to database
2025-01-15 10:30:15 [INFO] GET /api/users - 200 - 45ms
```

---

## 9. Web Dashboard

### 9.1 Overview

Modern React-based SPA for visual management of DROP platform.

**Technology Stack**:
- React 18 with TypeScript
- Vite for bundling
- TanStack Query for data fetching
- TanStack Router for routing
- Tailwind CSS for styling
- Recharts for visualizations
- Lucide React for icons

### 9.2 Pages & Routes

```typescript
const routes = [
  // Dashboard
  { path: '/', component: Dashboard },

  // Apps
  { path: '/apps', component: AppsList },
  { path: '/apps/:name', component: AppDetail },
  { path: '/apps/:name/deployments', component: Deployments },
  { path: '/apps/:name/logs', component: LogViewer },
  { path: '/apps/:name/settings', component: AppSettings },
  { path: '/apps/:name/env', component: EnvEditor },
  { path: '/apps/:name/domains', component: DomainManager },
  { path: '/apps/:name/database', component: DatabaseManager },

  // System
  { path: '/system', component: SystemStatus },
  { path: '/system/config', component: SystemConfig },
  { path: '/system/logs', component: SystemLogs },

  // Tenants (multi-tenancy)
  { path: '/tenants', component: TenantsList },
  { path: '/tenants/:id', component: TenantDetail },

  // Settings
  { path: '/settings', component: Settings },
  { path: '/settings/api-keys', component: ApiKeys },
];
```

### 9.3 Dashboard View

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DROP Dashboard                                    [User] [Settings]     │
├────────────┬────────────────────────────────────────────────────────────┤
│            │                                                             │
│  Dashboard │   System Overview                                          │
│  Apps      │   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  Tenants   │   │ Apps: 12 │  │ Running:8│  │ CPU: 23% │  │ Mem: 4GB │  │
│  System    │   └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│  Settings  │                                                             │
│            │   Applications                           [+ New App]        │
│            │   ┌─────────────────────────────────────────────────────┐  │
│            │   │ ● my-api        node/express   running   3001      │  │
│            │   │ ● portfolio     static         running   -         │  │
│            │   │ ○ dashboard     nextjs         stopped   3002      │  │
│            │   └─────────────────────────────────────────────────────┘  │
│            │                                                             │
│            │   Resource Usage                                            │
│            │   ┌─────────────────────────────────────────────────────┐  │
│            │   │  [CPU/Memory Graph over time]                       │  │
│            │   └─────────────────────────────────────────────────────┘  │
│            │                                                             │
│            │   Recent Activity                                           │
│            │   • my-api deployed (2 min ago)                            │
│            │   • dashboard stopped (1 hour ago)                         │
│            │   • portfolio SSL renewed (1 day ago)                      │
└────────────┴────────────────────────────────────────────────────────────┘
```

### 9.4 Component Architecture

```
src/
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx
│   │   ├── Header.tsx
│   │   ├── Layout.tsx
│   │   └── Breadcrumb.tsx
│   ├── apps/
│   │   ├── AppCard.tsx
│   │   ├── AppList.tsx
│   │   ├── AppStatus.tsx
│   │   ├── DeploymentHistory.tsx
│   │   └── LogViewer.tsx
│   ├── charts/
│   │   ├── ResourceChart.tsx
│   │   ├── RequestsChart.tsx
│   │   └── UptimeChart.tsx
│   └── ui/
│       ├── Button.tsx
│       ├── Card.tsx
│       ├── Modal.tsx
│       ├── Table.tsx
│       ├── Input.tsx
│       └── Select.tsx
├── pages/
│   ├── Dashboard.tsx
│   ├── apps/
│   │   ├── index.tsx
│   │   └── [name]/
│   │       ├── index.tsx
│   │       ├── deployments.tsx
│   │       └── settings.tsx
│   └── system/
│       ├── index.tsx
│       └── config.tsx
├── hooks/
│   ├── useApps.ts
│   ├── useWebSocket.ts
│   ├── useMetrics.ts
│   └── useAuth.ts
├── lib/
│   ├── api.ts
│   ├── ws.ts
│   └── utils.ts
└── types/
    └── index.ts
```

---

## 10. Multi-Tenancy & Billing

### 10.1 Tenant Model

```typescript
interface Tenant {
  id: string;
  name: string;
  email: string;
  apiKey: string;
  plan: Plan;
  limits: TenantLimits;
  usage: TenantUsage;
  billing?: BillingInfo;
  createdAt: Date;
  updatedAt: Date;
}

interface TenantLimits {
  apps: number;
  bandwidth: number;        // bytes per month
  storage: number;          // bytes
  databases: number;
  customDomains: number;
  deployments: number;      // per month
  collaborators: number;
}

interface TenantUsage {
  apps: number;
  bandwidth: number;
  storage: number;
  databases: number;
  customDomains: number;
  deployments: number;
}

interface BillingInfo {
  provider: 'paystack' | 'stripe';
  customerId: string;
  subscriptionId: string;
  paymentMethod?: string;
  billingEmail: string;
}
```

### 10.2 Plans Configuration

```typescript
const PLANS: Record<string, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'USD',
    interval: 'month',
    limits: {
      apps: 3,
      bandwidth: 10 * GB,
      storage: 1 * GB,
      databases: 1,
      customDomains: 0,
      deployments: 100,
      collaborators: 1,
    },
    features: ['Community support', 'Auto-deploy', 'SSL'],
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    price: 900,          // $9/month or equivalent
    currency: 'USD',
    interval: 'month',
    limits: {
      apps: 10,
      bandwidth: 100 * GB,
      storage: 10 * GB,
      databases: 5,
      customDomains: 5,
      deployments: 500,
      collaborators: 3,
    },
    features: ['Email support', 'Custom domains', 'Daily backups'],
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    price: 2900,         // $29/month
    currency: 'USD',
    interval: 'month',
    limits: {
      apps: 50,
      bandwidth: 500 * GB,
      storage: 50 * GB,
      databases: 25,
      customDomains: 25,
      deployments: -1,   // Unlimited
      collaborators: 10,
    },
    features: ['Priority support', 'Team access', 'Hourly backups', 'Metrics'],
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: -1,           // Custom pricing
    currency: 'USD',
    interval: 'month',
    limits: {
      apps: -1,
      bandwidth: -1,
      storage: -1,
      databases: -1,
      customDomains: -1,
      deployments: -1,
      collaborators: -1,
    },
    features: ['Dedicated support', 'SLA', 'Custom integrations', 'On-premise'],
  },
};
```

### 10.3 Usage Tracking

```typescript
class UsageTracker {
  async trackBandwidth(appId: string, bytes: number): Promise<void> {
    await this.db.run(`
      INSERT INTO usage_logs (app_id, type, value, timestamp)
      VALUES (?, 'bandwidth', ?, datetime('now'))
    `, [appId, bytes]);
  }

  async trackDeployment(appId: string): Promise<void> {
    await this.db.run(`
      INSERT INTO usage_logs (app_id, type, value, timestamp)
      VALUES (?, 'deployment', 1, datetime('now'))
    `, [appId]);
  }

  async getMonthlyUsage(tenantId: string): Promise<TenantUsage> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const result = await this.db.get(`
      SELECT
        COUNT(DISTINCT a.id) as apps,
        COALESCE(SUM(CASE WHEN ul.type = 'bandwidth' THEN ul.value ELSE 0 END), 0) as bandwidth,
        COALESCE(SUM(CASE WHEN ul.type = 'storage' THEN ul.value ELSE 0 END), 0) as storage,
        COUNT(DISTINCT d.id) as databases,
        COALESCE(SUM(CASE WHEN ul.type = 'deployment' THEN ul.value ELSE 0 END), 0) as deployments
      FROM apps a
      LEFT JOIN app_tenants at ON a.id = at.app_id
      LEFT JOIN usage_logs ul ON a.id = ul.app_id AND ul.timestamp >= ?
      LEFT JOIN databases d ON a.id = d.app_id
      WHERE at.tenant_id = ?
    `, [startOfMonth.toISOString(), tenantId]);

    return result;
  }

  async checkLimits(tenantId: string, action: string): Promise<boolean> {
    const tenant = await this.getTenant(tenantId);
    const usage = await this.getMonthlyUsage(tenantId);
    const limits = tenant.plan.limits;

    switch (action) {
      case 'create_app':
        return limits.apps === -1 || usage.apps < limits.apps;
      case 'deploy':
        return limits.deployments === -1 || usage.deployments < limits.deployments;
      case 'add_domain':
        return limits.customDomains === -1 || usage.customDomains < limits.customDomains;
      default:
        return true;
    }
  }
}
```

### 10.4 Payment Integration

```typescript
// Paystack Integration (Africa-focused)
class PaystackBilling implements BillingProvider {
  private client: Paystack;

  async createCustomer(tenant: Tenant): Promise<string> {
    const response = await this.client.customer.create({
      email: tenant.email,
      first_name: tenant.name,
      metadata: { tenantId: tenant.id },
    });
    return response.data.customer_code;
  }

  async createSubscription(customerId: string, planCode: string): Promise<Subscription> {
    const response = await this.client.subscription.create({
      customer: customerId,
      plan: planCode,
    });
    return response.data;
  }

  async handleWebhook(event: PaystackEvent): Promise<void> {
    switch (event.event) {
      case 'subscription.create':
        await this.activateSubscription(event.data);
        break;
      case 'charge.success':
        await this.recordPayment(event.data);
        break;
      case 'subscription.disable':
        await this.handleCancellation(event.data);
        break;
      case 'invoice.payment_failed':
        await this.handleFailedPayment(event.data);
        break;
    }
  }
}

// Stripe Integration (International)
class StripeBilling implements BillingProvider {
  private stripe: Stripe;

  async createCustomer(tenant: Tenant): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: tenant.email,
      name: tenant.name,
      metadata: { tenantId: tenant.id },
    });
    return customer.id;
  }

  async createSubscription(customerId: string, priceId: string): Promise<Subscription> {
    const subscription = await this.stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
    return subscription;
  }
}

---

## 11. Security Model

### 11.1 Authentication

```typescript
// API Key Authentication
class ApiKeyAuth {
  async authenticate(req: Request): Promise<Tenant | null> {
    const apiKey = req.headers.get('authorization')?.replace('Bearer ', '')
                || req.headers.get('x-api-key');

    if (!apiKey) return null;

    // Keys prefixed: dk_live_xxx (production), dk_test_xxx (test)
    const tenant = await this.db.get(
      'SELECT * FROM tenants WHERE api_key = ?',
      [apiKey]
    );

    return tenant;
  }

  generateApiKey(type: 'live' | 'test' = 'live'): string {
    const prefix = type === 'live' ? 'dk_live_' : 'dk_test_';
    return prefix + crypto.randomBytes(24).toString('base64url');
  }
}

// Dashboard Authentication
class DashboardAuth {
  // Session-based with JWT tokens
  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.findUser(email);
    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      throw new AuthError('Invalid credentials');
    }

    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenantId },
      this.jwtSecret,
      { expiresIn: '7d' }
    );

    return { token, user };
  }
}
```

### 11.2 App Isolation

```typescript
class AppIsolation {
  getIsolationConfig(appName: string): IsolationConfig {
    return {
      // Filesystem isolation
      workDir: `/var/drop/data/webapps/${appName}`,
      dataDir: `/var/drop/data/appdata/${appName}`,
      tmpDir: `/var/drop/data/temp/${appName}`,

      // Network isolation
      port: this.assignedPort,
      bindHost: '127.0.0.1',  // Only localhost, Caddy proxies

      // Process isolation
      user: `drop-${appName}`,  // Future: per-app users
      memoryLimit: this.config.resources?.memory || '256mb',

      // Environment isolation
      env: {
        HOME: `/var/drop/data/appdata/${appName}`,
        TMPDIR: `/var/drop/data/temp/${appName}`,
        NODE_ENV: 'production',
        ...this.resolvedEnv,
      },
    };
  }
}
```

### 11.3 Secret Management

```typescript
class SecretManager {
  private readonly encryptionKey: Buffer;

  constructor() {
    this.encryptionKey = this.loadOrCreateKey();
  }

  async setSecret(appName: string, key: string, value: string): Promise<void> {
    const encrypted = this.encrypt(value);
    await this.db.run(`
      INSERT OR REPLACE INTO secrets (id, app_id, key, value, created_at)
      VALUES (?, (SELECT id FROM apps WHERE name = ?), ?, ?, datetime('now'))
    `, [nanoid(), appName, key, encrypted]);
  }

  async getSecret(appName: string, key: string): Promise<string | null> {
    const row = await this.db.get(`
      SELECT s.value FROM secrets s
      JOIN apps a ON s.app_id = a.id
      WHERE a.name = ? AND s.key = ?
    `, [appName, key]);

    return row ? this.decrypt(row.value) : null;
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, 16);
    const tag = data.subarray(16, 32);
    const encrypted = data.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }
}
```

### 11.4 Security Headers & Best Practices

```typescript
// Default security headers applied via Caddy
const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Rate limiting
class RateLimiter {
  private readonly limits = {
    api: { windowMs: 60000, max: 100 },
    deploy: { windowMs: 3600000, max: 10 },
    login: { windowMs: 900000, max: 5 },
  };

  async checkLimit(key: string, type: keyof typeof this.limits): Promise<boolean> {
    const limit = this.limits[type];
    const count = await this.redis.incr(`ratelimit:${type}:${key}`);

    if (count === 1) {
      await this.redis.expire(`ratelimit:${type}:${key}`, limit.windowMs / 1000);
    }

    return count <= limit.max;
  }
}
```

---

## 12. Plugin Architecture

### 12.1 Plugin Interface

```typescript
interface DropPlugin {
  name: string;
  version: string;
  description: string;

  // Lifecycle hooks
  onLoad?(drop: DropCore): Promise<void>;
  onUnload?(): Promise<void>;

  // Event handlers
  onAppCreated?(app: App): Promise<void>;
  onAppDeployed?(app: App, deployment: Deployment): Promise<void>;
  onAppDeleted?(app: App): Promise<void>;

  // Service providers
  providers?: {
    database?: DatabaseProvisioner;
    storage?: StorageProvider;
    billing?: BillingProvider;
    notification?: NotificationProvider;
  };

  // API extensions
  routes?: RouteDefinition[];

  // CLI extensions
  commands?: CommandDefinition[];
}
```

### 12.2 Built-in Plugins

```typescript
// PostgreSQL Plugin
const postgresPlugin: DropPlugin = {
  name: 'postgres',
  version: '1.0.0',
  description: 'PostgreSQL database provisioning',

  providers: {
    database: new PostgreSQLProvisioner(config),
  },

  commands: [
    {
      name: 'pg:psql',
      description: 'Open PostgreSQL shell',
      action: async (appName: string) => {
        const db = await getAppDatabase(appName);
        await execInteractive('psql', [db.url]);
      },
    },
  ],
};

// Redis Plugin
const redisPlugin: DropPlugin = {
  name: 'redis',
  version: '1.0.0',
  description: 'Redis cache provisioning',

  async onAppCreated(app) {
    if (app.config.cache?.type === 'redis') {
      await this.provisionRedis(app.name);
    }
  },
};

// S3 Storage Plugin
const s3Plugin: DropPlugin = {
  name: 's3',
  version: '1.0.0',
  description: 'S3-compatible object storage',

  providers: {
    storage: new S3StorageProvider(config),
  },
};
```

### 12.3 Plugin Loading

```typescript
class PluginManager {
  private plugins = new Map<string, DropPlugin>();

  async loadPlugin(pluginPath: string): Promise<void> {
    const plugin = await import(pluginPath);

    if (!this.validatePlugin(plugin)) {
      throw new Error(`Invalid plugin: ${pluginPath}`);
    }

    await plugin.onLoad?.(this.drop);
    this.plugins.set(plugin.name, plugin);

    // Register providers
    if (plugin.providers?.database) {
      this.drop.registerDatabaseProvider(plugin.name, plugin.providers.database);
    }

    // Register routes
    if (plugin.routes) {
      this.drop.api.registerRoutes(plugin.routes);
    }

    // Register CLI commands
    if (plugin.commands) {
      this.drop.cli.registerCommands(plugin.commands);
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin) {
      await plugin.onUnload?.();
      this.plugins.delete(name);
    }
  }
}
```

---

## 13. Monitoring & Observability

### 13.1 Metrics Collection

```typescript
interface AppMetrics {
  timestamp: Date;
  appName: string;

  // Process metrics
  cpu: number;           // Percentage
  memory: number;        // Bytes
  memoryLimit: number;   // Bytes
  uptime: number;        // Seconds
  restarts: number;

  // Request metrics (if available)
  requests?: {
    total: number;
    active: number;
    rate: number;        // Per second
  };

  // Response metrics
  responses?: {
    latencyP50: number;  // ms
    latencyP95: number;  // ms
    latencyP99: number;  // ms
    errorRate: number;   // Percentage
  };
}

class MetricsCollector {
  async collectAppMetrics(appName: string): Promise<AppMetrics> {
    const pm2Status = await this.pm2.getStatus(appName);

    return {
      timestamp: new Date(),
      appName,
      cpu: pm2Status.cpu,
      memory: pm2Status.memory,
      memoryLimit: pm2Status.memoryLimit,
      uptime: pm2Status.uptime,
      restarts: pm2Status.restarts,
    };
  }

  async collectSystemMetrics(): Promise<SystemMetrics> {
    return {
      timestamp: new Date(),
      cpu: await this.getCpuUsage(),
      memory: await this.getMemoryUsage(),
      disk: await this.getDiskUsage(),
      network: await this.getNetworkStats(),
      apps: {
        total: await this.getAppCount(),
        running: await this.getRunningAppCount(),
      },
    };
  }
}
```

### 13.2 Logging

```typescript
class LogManager {
  private readonly logDir = '/var/drop/data/logs/apps';

  async writeLogs(appName: string, logs: LogEntry[]): Promise<void> {
    const logPath = path.join(this.logDir, appName, 'app.log');
    const stream = fs.createWriteStream(logPath, { flags: 'a' });

    for (const log of logs) {
      stream.write(JSON.stringify(log) + '\n');
    }

    stream.end();
  }

  async queryLogs(appName: string, options: LogQueryOptions): Promise<LogEntry[]> {
    const logPath = path.join(this.logDir, appName, 'app.log');

    return new Promise((resolve, reject) => {
      const results: LogEntry[] = [];
      const stream = fs.createReadStream(logPath);
      const rl = readline.createInterface({ input: stream });

      rl.on('line', (line) => {
        try {
          const entry = JSON.parse(line) as LogEntry;

          if (this.matchesFilter(entry, options)) {
            results.push(entry);
          }
        } catch {}
      });

      rl.on('close', () => {
        // Apply limit and offset
        const sliced = results.slice(
          options.offset || 0,
          (options.offset || 0) + (options.limit || 100)
        );
        resolve(sliced);
      });

      rl.on('error', reject);
    });
  }
}
```

### 13.3 Health Checks

```typescript
class HealthChecker {
  async checkAppHealth(appName: string): Promise<HealthStatus> {
    const app = await this.registry.getApp(appName);
    const config = app.config.health || { path: '/health', timeout: 5000 };

    try {
      const response = await fetch(`http://localhost:${app.port}${config.path}`, {
        signal: AbortSignal.timeout(config.timeout),
      });

      return {
        healthy: response.ok,
        status: response.status,
        latency: Date.now() - startTime,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        checkedAt: new Date(),
      };
    }
  }

  async runHealthChecks(): Promise<void> {
    const apps = await this.registry.getRunningApps();

    for (const app of apps) {
      const health = await this.checkAppHealth(app.name);

      if (!health.healthy) {
        this.consecutiveFailures.set(
          app.name,
          (this.consecutiveFailures.get(app.name) || 0) + 1
        );

        const threshold = app.config.health?.unhealthyThreshold || 3;
        if (this.consecutiveFailures.get(app.name) >= threshold) {
          await this.handleUnhealthyApp(app);
        }
      } else {
        this.consecutiveFailures.set(app.name, 0);
      }
    }
  }
}
```

---

## 14. Directory Structure

### 14.1 Platform Directories

DROP separates the **platform** from **user data** to enable seamless upgrades. When upgrading DROP, only the `/var/drop/apps/` directory is replaced—all user webapps and data remain untouched.

```
/var/drop/
│
├── apps/                               # PLATFORM (replaced during upgrade)
│   └── drop-svc/                       # DROP service
│       ├── bin/                        # CLI binaries and scripts
│       │   ├── drop                    # Main CLI executable
│       │   └── drop-svc                # Service daemon
│       ├── lib/                        # Platform libraries
│       │   └── node_modules/           # Dependencies
│       ├── dashboard/                  # Dashboard web assets
│       │   └── dist/                   # Built dashboard files
│       ├── version.json                # Version info
│       └── install.sh                  # Installation/upgrade script
│
└── data/                               # USER DATA (preserved during upgrade)
    │
    ├── webapps/                        # Deployed web applications
    │   ├── my-api/                     # Simple subdomain app
    │   │   ├── drop.json
    │   │   ├── package.json
    │   │   ├── server.js
    │   │   └── ...
    │   ├── api.example.com/            # Hostname-based routing
    │   │   ├── ROOT/                   # Context path: /
    │   │   │   └── ...
    │   │   ├── v1/                     # Context path: /v1
    │   │   │   └── ...
    │   │   └── api.example.com.conf    # Host configuration
    │   └── portfolio/
    │       ├── index.html
    │       └── ...
    │
    ├── drop-svc/                       # Core service data
    │   ├── drop.db                     # Main platform database
    │   ├── encryption.key              # Master encryption key
    │   └── pm2/                        # PM2 configurations
    │       └── my-api.config.cjs
    │
    ├── db/                             # App databases
    │   ├── my-api.db                   # SQLite databases
    │   └── ...
    │
    ├── appdata/                        # Per-app persistent data
    │   └── my-api/
    │       ├── uploads/
    │       └── cache/
    │
    ├── logs/                           # All logs
    │   ├── drop-svc/                   # Platform logs
    │   │   ├── api.log
    │   │   ├── watcher.log
    │   │   └── error.log
    │   ├── caddy/                      # Reverse proxy logs
    │   │   └── access.log
    │   └── webapps/                    # Per-app logs
    │       └── my-api/
    │           ├── out.log
    │           ├── error.log
    │           └── access.log
    │
    ├── appconf/                        # Configuration files
    │   ├── drop.yaml                   # Main configuration
    │   ├── plugins/                    # Plugin configs
    │   └── caddy/                      # Caddy configurations
    │       ├── webapps/
    │       │   └── my-api.caddy
    │       └── hosts/
    │           └── api.example.com.caddy
    │
    ├── backup/                         # Automated backups
    │   └── my-api/
    │       ├── 2025-01-15T02-00-00Z.db
    │       └── ...
    │
    └── temp/                           # Temporary files
        └── my-api/                     # Per-app temp files
```

### 14.2 Upgrade Strategy

```bash
# Upgrade DROP without affecting running webapps:
# 1. Download new version
curl -fsSL https://drop.dev/releases/latest.tar.gz -o drop-latest.tar.gz

# 2. Stop DROP service (webapps keep running via PM2)
drop service stop

# 3. Replace platform directory only
rm -rf /var/drop/apps/drop-svc
tar -xzf drop-latest.tar.gz -C /var/drop/apps/

# 4. Restart DROP service
drop service start

# Webapps in /var/drop/data/webapps/ are untouched throughout the process
```

### 14.3 Directory Separation Rationale

| Directory | Purpose | During Upgrade |
|-----------|---------|----------------|
| `/var/drop/apps/drop-svc/` | Platform binaries, libs, dashboard | **Replaced** |
| `/var/drop/data/webapps/` | User web applications | Preserved |
| `/var/drop/data/drop-svc/` | Platform state (DB, keys) | Preserved |
| `/var/drop/data/db/` | App databases | Preserved |
| `/var/drop/data/appdata/` | App persistent data | Preserved |
| `/var/drop/data/logs/` | All logs | Preserved |
| `/var/drop/data/appconf/` | User configuration | Preserved |
| `/var/drop/data/backup/` | Backups | Preserved |
| `/var/drop/data/temp/` | Temp files | Can be cleared |

### 14.2 Source Code Structure

```
drop/
├── packages/
│   ├── core/                       # Core engine
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── watcher.ts
│   │   │   ├── detector.ts
│   │   │   ├── builder.ts
│   │   │   ├── process-manager.ts
│   │   │   ├── domain-manager.ts
│   │   │   ├── database-manager.ts
│   │   │   ├── secret-manager.ts
│   │   │   ├── registry.ts
│   │   │   └── events.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── api/                        # REST API
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   └── websocket.ts
│   │   └── package.json
│   ├── cli/                        # CLI tool
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── commands/
│   │   └── package.json
│   ├── dashboard/                  # Web UI
│   │   ├── src/
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── shared/                     # Shared utilities
│       ├── src/
│       │   ├── types.ts
│       │   ├── config.ts
│       │   └── utils.ts
│       └── package.json
├── plugins/
│   ├── postgres/
│   ├── redis/
│   └── s3/
├── scripts/
│   ├── install.sh
│   ├── install.ps1                 # Windows installer
│   └── setup.ts
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

---

## 15. Technology Stack

### 15.1 Core Technologies

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Node.js 20 LTS | Stable, TypeScript support |
| Language | TypeScript 5.x | Type safety, better DX |
| Package Manager | pnpm | Fast, disk efficient |
| Monorepo | Turborepo | Fast builds, caching |
| Database | better-sqlite3 | Fast, zero-config |
| Process Manager | PM2 | Production-ready |
| Reverse Proxy | Caddy 2.x | Auto-HTTPS, simple config |
| API Framework | Hono | Lightweight, fast |
| CLI Framework | Commander.js | Standard, documented |
| File Watcher | chokidar | Cross-platform |
| Dashboard | React 18 + Vite | Fast DX |
| Styling | Tailwind CSS | Utility-first |

### 15.2 Dependencies

```json
{
  "dependencies": {
    "hono": "^4.0.0",
    "better-sqlite3": "^11.0.0",
    "chokidar": "^3.6.0",
    "pm2": "^5.3.0",
    "commander": "^12.0.0",
    "zod": "^3.23.0",
    "nanoid": "^5.0.0",
    "dotenv": "^16.4.0",
    "chalk": "^5.3.0",
    "ora": "^8.0.0",
    "ws": "^8.16.0",
    "node-cron": "^3.0.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.0.0",
    "turbo": "^2.0.0"
  }
}
```

---

## 16. Implementation Phases

### Phase 1: MVP Foundation
**Focus**: Core deployment pipeline

**Deliverables**:
- Project setup (monorepo, TypeScript, tooling)
- Watcher service with file change detection
- Detector service (Node.js, static sites)
- Builder service with npm support
- PM2 process management integration
- SQLite registry
- Basic Caddy configuration
- REST API (apps CRUD, status)
- CLI (deploy, start, stop, logs, list)

**Success Criteria**:
- Drop a Node.js app folder → auto-deploy → accessible via subdomain
- Drop a static site folder → served via Caddy

### Phase 2: Enhanced Experience
**Focus**: Production readiness

**Deliverables**:
- Git deployment support
- Environment variable management
- Secret management with encryption
- Health checks and auto-restart
- Log aggregation and querying
- Web dashboard (basic)
- Custom domain support
- Database backups

### Phase 3: Multi-Tenancy
**Focus**: Commercial features

**Deliverables**:
- Tenant model and isolation
- API key authentication
- Usage tracking and metering
- Billing integration (Paystack, Stripe)
- Plan limits enforcement
- Client portal

### Phase 4: Ecosystem
**Focus**: Extensibility

**Deliverables**:
- Plugin architecture
- PostgreSQL plugin
- Redis plugin
- Python/Go support
- Docker support
- Advanced monitoring
- Prometheus metrics export

---

## 17. Cross-Platform Support

### 17.1 Platform Abstraction

```typescript
class PlatformPaths {
  static get dataDir(): string {
    switch (process.platform) {
      case 'win32':
        return process.env.DROP_DATA_DIR || 'C:\\ProgramData\\drop';
      case 'darwin':
        return process.env.DROP_DATA_DIR || '/usr/local/var/drop';
      default:
        return process.env.DROP_DATA_DIR || '/var/drop';
    }
  }

  static get configDir(): string {
    switch (process.platform) {
      case 'win32':
        return path.join(this.dataDir, 'config');
      default:
        return '/etc/drop';
    }
  }

  static get appsDir(): string {
    return path.join(this.dataDir, 'apps');
  }
}
```

### 17.2 Windows Support

```typescript
// Windows-specific process management
class WindowsProcessManager implements ProcessManager {
  async start(appName: string): Promise<ProcessStatus> {
    // Use PM2 on Windows (works well)
    return this.pm2Start(appName);
  }

  // Windows service installation
  async installService(): Promise<void> {
    await execa('pm2-installer', ['install']);
  }
}

// Windows Caddy setup
class WindowsCaddyManager {
  async install(): Promise<void> {
    // Install Caddy via winget or chocolatey
    await execa('winget', ['install', 'Caddy.Caddy']);
  }

  async installService(): Promise<void> {
    await execa('caddy', ['service', 'install']);
  }
}
```

### 17.3 Development Mode

```typescript
// Cross-platform development setup
class DevEnvironment {
  async setup(): Promise<void> {
    // Create data directories
    await fs.ensureDir(PlatformPaths.appsDir);
    await fs.ensureDir(path.join(PlatformPaths.dataDir, 'data'));
    await fs.ensureDir(path.join(PlatformPaths.dataDir, 'logs'));

    // Initialize database
    await this.initDatabase();

    // Start services
    await this.startCaddy();
    await this.startPM2();
  }

  // Use local Caddy with custom config for development
  private async startCaddy(): Promise<void> {
    const caddyfile = `
      {
        admin localhost:2019
        auto_https off
      }
      :80 {
        respond "DROP Development Server"
      }
    `;
    // ...
  }
}
```

---

## 18. Replication & High Availability

DROP supports PRIMARY/REPLICA clustering for high availability and disaster recovery.

### 18.1 Replication Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DROP REPLICATION CLUSTER                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐              ┌─────────────────┐                       │
│  │   PRIMARY NODE  │    DRCP      │   REPLICA NODE  │                       │
│  │                 │◄────────────►│                 │                       │
│  │  drop-svc       │   (sync)     │  drop-svc       │                       │
│  │  webapps/       │              │  webapps/       │                       │
│  │  drop.db        │              │  drop.db        │                       │
│  └────────┬────────┘              └────────┬────────┘                       │
│           │                                │                                 │
│           ▼                                ▼                                 │
│  ┌─────────────────┐              ┌─────────────────┐                       │
│  │   PostgreSQL    │   Streaming  │   PostgreSQL    │                       │
│  │   (PRIMARY)     │─────────────►│   (REPLICA)     │                       │
│  └─────────────────┘    WAL       └─────────────────┘                       │
│                                                                              │
│  Modes: PRIMARY | REPLICA | PROMOTED                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 18.2 Replication Modes

```typescript
type ReplicationMode = 'PRIMARY' | 'REPLICA' | 'PROMOTED';

interface ReplicationConfig {
  mode: ReplicationMode;
  clusterId: string;                    // Unique cluster identifier
  nodeId: string;                       // Unique node identifier

  // Primary configuration
  primary?: {
    allowedReplicas: string[];          // Authorized replica node IDs
    syncInterval: number;               // File sync interval (ms)
    walArchiving: boolean;              // Enable WAL archiving
  };

  // Replica configuration
  replica?: {
    primaryHost: string;                // Primary node hostname
    primaryPort: number;                // Primary node port
    authToken: string;                  // Authentication token
    promotable: boolean;                // Can this replica be promoted?
    syncOnStartup: boolean;             // Full sync on startup
  };
}

interface ReplicationStatus {
  mode: ReplicationMode;
  connected: boolean;
  lastSync: Date;
  lag: number;                          // Replication lag in ms
  primaryNode?: string;
  replicaNodes: string[];
  filesInSync: number;
  filesPending: number;
}
```

### 18.3 DROP Cluster Protocol (DRCP)

High-speed replication communication protocol for DROP clusters.

```typescript
interface DRCPConnection {
  // Connection establishment
  connect(host: string, port: number): Promise<void>;
  authenticate(nodeId: string, token: string): Promise<boolean>;
  disconnect(): Promise<void>;

  // Data synchronization
  syncFiles(since: Date): Promise<FileChange[]>;
  syncDatabase(since: number): Promise<DatabaseChange[]>;
  streamWAL(startLSN: string): AsyncIterable<WALRecord>;

  // Cluster coordination
  heartbeat(): Promise<HeartbeatResponse>;
  requestPromotion(): Promise<PromotionResult>;
  notifyPromotion(newPrimary: string): Promise<void>;
}

interface FileChange {
  type: 'modified' | 'deleted' | 'renamed';
  path: string;
  checksum?: string;
  size?: number;
  timestamp: Date;
  content?: Buffer;                     // For small files
}

interface DRCPMessage {
  version: number;                      // Protocol version
  type: DRCPMessageType;
  timestamp: Date;
  payload: Buffer;                      // GZIP compressed
  checksum: string;                     // SHA-256
}

type DRCPMessageType =
  | 'AUTH_REQUEST'
  | 'AUTH_RESPONSE'
  | 'SYNC_REQUEST'
  | 'SYNC_RESPONSE'
  | 'FILE_CHANGE'
  | 'WAL_RECORD'
  | 'HEARTBEAT'
  | 'PROMOTION_REQUEST'
  | 'PROMOTION_NOTIFY';
```

### 18.4 File Synchronization

DROP uses **microsecond precision** for file timestamps to ensure compatibility with rsync and other sync tools. This prevents unnecessary re-syncs when files have been synchronized by external tools.

```typescript
class FileSyncManager {
  private syncHistory: Map<string, FileChange[]> = new Map();
  private maxHistorySize = 100 * 1024 * 1024;  // 100MB history buffer

  // Use microsecond precision for timestamps (rsync compatible)
  // Truncate nanoseconds to microseconds for compatibility
  private normalizeTimestamp(timestamp: Date | number): number {
    const ms = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
    // Truncate to microsecond precision (rsync uses microseconds)
    return Math.floor(ms / 1000) * 1000;
  }

  // Compare file timestamps with microsecond precision
  private timestampsEqual(a: number, b: number): boolean {
    return this.normalizeTimestamp(a) === this.normalizeTimestamp(b);
  }

  // Record file changes for replication
  recordChange(change: FileChange): void {
    // Normalize timestamp to microsecond precision
    change.timestamp = new Date(this.normalizeTimestamp(change.timestamp));
    this.syncHistory.get(change.path)?.push(change);
    this.pruneHistory();
  }

  // Get changes since timestamp
  getChangesSince(since: Date): FileChange[] {
    const normalizedSince = this.normalizeTimestamp(since);
    const changes: FileChange[] = [];
    for (const [path, history] of this.syncHistory) {
      const relevant = history.filter(c =>
        this.normalizeTimestamp(c.timestamp) > normalizedSince
      );
      changes.push(...relevant);
    }
    return changes.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Sync directory to replica
  async syncDirectory(dir: string, replica: DRCPConnection): Promise<SyncResult> {
    const localFiles = await this.scanDirectory(dir);
    const remoteFiles = await replica.getFileList(dir);

    // Compare with microsecond precision
    const toUpload = this.diffFiles(localFiles, remoteFiles, {
      compareTimestamps: (a, b) => !this.timestampsEqual(a, b)
    });
    const toDelete = this.findDeleted(localFiles, remoteFiles);

    for (const file of toUpload) {
      await replica.uploadFile(file.path, file.content);
    }

    for (const file of toDelete) {
      await replica.deleteFile(file.path);
    }

    return { uploaded: toUpload.length, deleted: toDelete.length };
  }

  // Trigger sync on webapp directory scan (like VPAS)
  async syncOnWebappScan(): Promise<void> {
    if (!this.isReplica()) return;

    // Sync webapps directory from primary
    const webappsDir = '/var/drop/data/webapps';
    await this.syncDirectory(webappsDir, this.primaryConnection);
  }
}
```

**Rsync Compatibility**:
- DROP truncates nanosecond timestamps to microsecond precision
- This matches rsync's timestamp resolution
- Prevents "phantom" file changes when using mixed sync tools
- Ensures consistent behavior: `rsync` → DROP sync → no unnecessary re-transfers

### 18.5 Replica Promotion

```typescript
class ReplicaPromotion {
  private watchdog: PrimaryWatchdog;

  // Monitor primary health
  async startWatchdog(primaryHost: string): Promise<void> {
    this.watchdog = new PrimaryWatchdog({
      primaryHost,
      checkInterval: 5000,              // 5 second health checks
      failureThreshold: 3,              // 3 failures to trigger promotion
      onPrimaryFailure: () => this.initiatePromotion(),
    });
    await this.watchdog.start();
  }

  // Initiate promotion process
  async initiatePromotion(): Promise<PromotionResult> {
    // 1. Verify primary is truly unreachable
    const primaryReachable = await this.verifyPrimaryDown();
    if (primaryReachable) {
      return { success: false, reason: 'Primary is still reachable' };
    }

    // 2. Check if this replica is promotable
    if (!this.config.replica?.promotable) {
      return { success: false, reason: 'Replica not configured as promotable' };
    }

    // 3. Coordinate with other replicas (multi-replica handshake)
    const consensus = await this.achieveConsensus();
    if (!consensus.shouldPromote) {
      return { success: false, reason: 'Consensus not achieved' };
    }

    // 4. Promote PostgreSQL to primary
    await this.promotePostgreSQL();

    // 5. Update replication mode
    await this.updateMode('PROMOTED');

    // 6. Notify other replicas
    await this.notifyReplicas();

    return { success: true, newMode: 'PROMOTED' };
  }

  // Demote back to replica when original primary returns
  async demote(): Promise<void> {
    // Stop accepting writes
    await this.setReadOnly(true);

    // Sync with new primary
    await this.syncWithPrimary();

    // Update mode
    await this.updateMode('REPLICA');
  }
}

interface PromotionResult {
  success: boolean;
  reason?: string;
  newMode?: ReplicationMode;
  timestamp?: Date;
}
```

### 18.6 Replication Configuration File

```yaml
# /var/drop/data/appconf/replication.yaml

cluster:
  id: "prod-cluster-001"
  encryption: true
  compressionLevel: 6                   # GZIP level (1-9)

node:
  id: "node-primary-001"
  mode: PRIMARY                         # PRIMARY | REPLICA
  host: "drop-primary.example.com"
  port: 9001                            # DRCP port

primary:
  allowedReplicas:
    - "node-replica-001"
    - "node-replica-002"
  syncInterval: 5000                    # 5 seconds
  walArchiving: true
  maxWalSize: "1GB"

# For replica nodes:
# replica:
#   primaryHost: "drop-primary.example.com"
#   primaryPort: 9001
#   authToken: "${DRCP_AUTH_TOKEN}"
#   promotable: true
#   syncOnStartup: true
#   reconnectInterval: 10000            # 10 seconds
```

### 18.7 CLI Commands for Replication

```bash
# Cluster status
drop cluster status                     # Show cluster status
drop cluster nodes                      # List all nodes

# Replication management
drop replicate init --primary           # Initialize as primary
drop replicate init --replica           # Initialize as replica
drop replicate sync                     # Force synchronization
drop replicate promote                  # Promote replica to primary
drop replicate demote                   # Demote to replica

# Monitoring
drop replicate lag                      # Show replication lag
drop replicate history                  # Show sync history
```

---

## 19. Command Server

DROP includes a local command server for secure inter-process communication and administrative operations.

### 19.1 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    DROP COMMAND SERVER                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐ │
│  │  CLI Client  │────►│   Command    │────►│  Command    │ │
│  │              │     │   Server     │     │  Handlers   │ │
│  └──────────────┘     │ (localhost)  │     └─────────────┘ │
│                       └──────────────┘                      │
│  ┌──────────────┐            │                              │
│  │  API Server  │────────────┘                              │
│  └──────────────┘                                           │
│                                                              │
│  Binding: 127.0.0.1:9002 (loopback only)                   │
│  Auth: 16-byte random key                                   │
│  Protocol: Binary framed messages                           │
└─────────────────────────────────────────────────────────────┘
```

### 19.2 Command Server Implementation

```typescript
interface CommandServerConfig {
  host: '127.0.0.1';                    // Loopback only for security
  port: number;                          // Default: 9002
  keyFile: string;                       // Path to auth key file
  timeout: number;                       // Command timeout (ms)
}

class CommandServer {
  private server: net.Server;
  private handlers: Map<string, CommandHandler> = new Map();
  private authKey: Buffer;               // 16-byte random key

  async start(config: CommandServerConfig): Promise<void> {
    // Load or generate authentication key
    this.authKey = await this.loadOrGenerateKey(config.keyFile);

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    // Bind to loopback only
    this.server.listen(config.port, '127.0.0.1');
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    // 1. Read auth message
    const authMsg = await this.readMessage(socket);
    if (!this.verifyAuth(authMsg)) {
      socket.destroy();
      return;
    }

    // 2. Send auth success
    await this.writeMessage(socket, { type: 'AUTH_OK' });

    // 3. Handle commands
    while (!socket.destroyed) {
      const cmd = await this.readMessage(socket);
      const result = await this.executeCommand(cmd);
      await this.writeMessage(socket, result);
    }
  }

  // Register command handler
  registerHandler(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  // Execute command
  private async executeCommand(cmd: CommandMessage): Promise<CommandResult> {
    const handler = this.handlers.get(cmd.command);
    if (!handler) {
      return { success: false, error: 'Unknown command' };
    }

    try {
      const result = await handler.execute(cmd.args);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

interface CommandMessage {
  command: string;
  args: Record<string, unknown>;
  requestId: string;
}

interface CommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

type CommandHandler = {
  execute(args: Record<string, unknown>): Promise<unknown>;
};
```

### 19.3 Built-in Commands

```typescript
// Register built-in commands
commandServer.registerHandler('app:start', new AppStartHandler());
commandServer.registerHandler('app:stop', new AppStopHandler());
commandServer.registerHandler('app:restart', new AppRestartHandler());
commandServer.registerHandler('app:status', new AppStatusHandler());
commandServer.registerHandler('app:logs', new AppLogsHandler());

commandServer.registerHandler('db:backup', new DatabaseBackupHandler());
commandServer.registerHandler('db:restore', new DatabaseRestoreHandler());

commandServer.registerHandler('system:status', new SystemStatusHandler());
commandServer.registerHandler('system:reload', new SystemReloadHandler());
commandServer.registerHandler('system:shutdown', new SystemShutdownHandler());

commandServer.registerHandler('wal:archive', new WALArchiveHandler());
commandServer.registerHandler('replica:sync', new ReplicaSyncHandler());
```

### 19.4 Client Implementation

```typescript
class CommandClient {
  private socket: net.Socket;

  async connect(port: number = 9002): Promise<void> {
    this.socket = net.createConnection({ host: '127.0.0.1', port });

    // Authenticate
    const keyFile = '/var/drop/data/drop-svc/command.key';
    const key = await fs.readFile(keyFile);

    await this.writeMessage({ type: 'AUTH', key: key.toString('base64') });
    const response = await this.readMessage();

    if (response.type !== 'AUTH_OK') {
      throw new Error('Authentication failed');
    }
  }

  async execute(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const requestId = nanoid();
    await this.writeMessage({ command, args, requestId });

    const result = await this.readMessage();
    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data;
  }

  async disconnect(): Promise<void> {
    this.socket.destroy();
  }
}

// Usage in CLI
const client = new CommandClient();
await client.connect();
const status = await client.execute('app:status', { appName: 'my-app' });
await client.disconnect();
```

---

## 20. System Maintenance

### 20.1 Directory Validation (Integrity Checker)

DROP validates the integrity of its directory structure to prevent configuration drift and detect unauthorized changes.

```typescript
interface DirectoryValidator {
  // Whitelist of expected directories and files
  whitelist: ValidationRule[];
  checkInterval: number;                // Default: 5 minutes
  errorCheckInterval: number;           // When errors found: 5 seconds
}

interface ValidationRule {
  path: string;                         // Glob pattern
  type: 'file' | 'directory';
  required: boolean;
  pattern?: RegExp;                     // Filename pattern
}

class IntegrityChecker {
  private whitelist: ValidationRule[] = [
    // Platform directories
    { path: '/var/drop/apps/drop-svc/**', type: 'directory', required: true },

    // User data directories
    { path: '/var/drop/data/webapps/*', type: 'directory', required: false },
    { path: '/var/drop/data/webapps/*/**', type: 'file', required: false },
    { path: '/var/drop/data/drop-svc/drop.db', type: 'file', required: true },
    { path: '/var/drop/data/drop-svc/pm2/*.config.cjs', type: 'file', required: false },
    { path: '/var/drop/data/db/*.db', type: 'file', required: false },
    { path: '/var/drop/data/logs/**/*.log', type: 'file', required: false },
    { path: '/var/drop/data/appconf/**', type: 'file', required: false },

    // Reject patterns (files that should NOT exist)
    { path: '/var/drop/data/**/*.exe', type: 'file', required: false, reject: true },
    { path: '/var/drop/data/**/*.sh', type: 'file', required: false, reject: true },
  ];

  private checkInterval = 5 * 60 * 1000;      // 5 minutes
  private errorCheckInterval = 5 * 1000;       // 5 seconds when issues found

  async validate(): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];

    // Check for unexpected files
    const allFiles = await this.scanAllFiles();
    for (const file of allFiles) {
      if (!this.isWhitelisted(file)) {
        issues.push({
          type: 'unexpected_file',
          path: file,
          message: `Unexpected file found: ${file}`,
        });
      }
    }

    // Check for missing required files
    for (const rule of this.whitelist.filter(r => r.required)) {
      if (!await this.exists(rule.path)) {
        issues.push({
          type: 'missing_required',
          path: rule.path,
          message: `Required path missing: ${rule.path}`,
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      checkedAt: new Date(),
    };
  }

  // Returns HTTP 500 with issues list when validation fails
  getHTTPResponse(result: ValidationResult): HTTPResponse {
    if (result.valid) {
      return { status: 200, body: { valid: true } };
    }

    return {
      status: 500,
      body: {
        valid: false,
        error: 'Directory validation failed',
        issues: result.issues,
      },
    };
  }
}

interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  checkedAt: Date;
}

interface ValidationIssue {
  type: 'unexpected_file' | 'missing_required' | 'invalid_permissions';
  path: string;
  message: string;
}
```

### 20.2 Temporary Directory Cleanup

```typescript
class TempCleanupManager {
  private cleanupAge = 24 * 60 * 60 * 1000;  // 24 hours
  private cleanupInterval = 60 * 60 * 1000;   // 1 hour

  async startCleanupScheduler(): Promise<void> {
    // Clean on startup
    await this.cleanup();

    // Schedule periodic cleanup
    setInterval(() => this.cleanup(), this.cleanupInterval);
  }

  async cleanup(): Promise<CleanupResult> {
    const tempDir = '/var/drop/data/temp';
    const deleted: string[] = [];

    const entries = await fs.readdir(tempDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(tempDir, entry.name);
      const stats = await fs.stat(fullPath);
      const age = Date.now() - stats.mtimeMs;

      if (age > this.cleanupAge) {
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true });
        } else {
          await fs.unlink(fullPath);
        }
        deleted.push(fullPath);
      }
    }

    return { deleted, cleanedAt: new Date() };
  }

  // Cleanup app-specific temp on app removal
  async cleanupAppTemp(appName: string): Promise<void> {
    const appTempDir = `/var/drop/data/temp/${appName}`;
    if (await this.exists(appTempDir)) {
      await fs.rm(appTempDir, { recursive: true });
    }
  }
}
```

### 20.3 Service Status HTTP Responses

DROP returns appropriate HTTP status codes based on service state.

```typescript
type ServiceState = 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED' | 'FAIL';

class ServiceStatusMiddleware {
  private state: ServiceState = 'STARTING';

  // Middleware for all HTTP requests
  handle(req: Request, res: Response, next: NextFunction): void {
    // Allow health check endpoint always
    if (req.path === '/health' || req.path === '/ready') {
      return next();
    }

    // Return 503 when not fully started
    if (this.state !== 'STARTED') {
      res.status(503).json({
        error: 'Service unavailable',
        state: this.state,
        message: this.getStateMessage(),
        retryAfter: 5,
      });
      return;
    }

    next();
  }

  private getStateMessage(): string {
    switch (this.state) {
      case 'STARTING':
        return 'Service is starting up, please wait...';
      case 'STOPPING':
        return 'Service is shutting down';
      case 'STOPPED':
        return 'Service is stopped';
      case 'FAIL':
        return 'Service failed to start';
      default:
        return 'Service unavailable';
    }
  }

  // State transitions
  setStarting(): void { this.state = 'STARTING'; }
  setStarted(): void { this.state = 'STARTED'; }
  setStopping(): void { this.state = 'STOPPING'; }
  setStopped(): void { this.state = 'STOPPED'; }
  setFailed(): void { this.state = 'FAIL'; }
}

// Health endpoints
app.get('/health', (req, res) => {
  res.json({
    status: serviceStatus.state === 'STARTED' ? 'healthy' : 'unhealthy',
    state: serviceStatus.state,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (req, res) => {
  if (serviceStatus.state === 'STARTED') {
    res.json({ ready: true });
  } else {
    res.status(503).json({ ready: false, state: serviceStatus.state });
  }
});
```

---

## 21. Appendices

### A. Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `APP_NOT_FOUND` | 404 | Application not found |
| `APP_ALREADY_EXISTS` | 409 | App name taken |
| `INVALID_MANIFEST` | 400 | drop.json validation failed |
| `BUILD_FAILED` | 500 | Build command failed |
| `START_FAILED` | 500 | Process failed to start |
| `PORT_UNAVAILABLE` | 500 | No available ports |
| `DB_PROVISION_FAILED` | 500 | Database provisioning failed |
| `UNAUTHORIZED` | 401 | Invalid/missing API key |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `RATE_LIMITED` | 429 | Too many requests |
| `LIMIT_EXCEEDED` | 402 | Plan limit reached |

### B. Environment Variables

**Platform Configuration**:

| Variable | Description | Default |
|----------|-------------|---------|
| `DROP_DOMAIN` | Base domain | `drop.local` |
| `DROP_DATA_DIR` | Data directory | `/var/drop` (platform-specific) |
| `DROP_API_PORT` | API server port | `9000` |
| `DROP_LOG_LEVEL` | Log level | `info` |
| `DROP_ADMIN_EMAIL` | ACME email | `admin@localhost` |

**Per-App (Auto-injected)**:

| Variable | Description |
|----------|-------------|
| `PORT` | Assigned port |
| `NODE_ENV` | Always `production` |
| `DATABASE_URL` | Database connection |
| `DATABASE_PATH` | SQLite file path |
| `APP_NAME` | Application name |
| `APP_URL` | Full application URL |
| `DROP_APP_HOME` | App data directory |

### C. Sample Applications

**Express API**:
```javascript
// server.js
const express = require('express');
const app = express();

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ healthy: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
```

**Static Site** (no config needed):
```
portfolio/
├── index.html
├── styles.css
└── script.js
```

**Next.js with Database**:
```json
{
  "name": "my-nextjs-app",
  "database": { "type": "sqlite" }
}
```

---

*END OF DROP PaaS SPECIFICATION v2.0*
