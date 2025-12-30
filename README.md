# DROP

**Deploy, Run, Operate, Publish**

A lightweight, self-hosted Platform as a Service (PaaS) engineered for the "drop folder and deploy" workflow. Zero-configuration deployment for Node.js, Python, Go, static sites, and containerized applications.

## Philosophy

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

## Features

- **Zero-Config Deployment** - Auto-detects app type, builds, and starts automatically
- **Multi-Runtime Support** - Node.js, Python, Go, Rust, PHP, Docker, static sites
- **Framework Detection** - Recognizes Next.js, Nuxt, SvelteKit, Remix, Astro, Express, FastAPI, Django, Flask, and more
- **Process Management** - Built on PM2 for reliable process management with auto-restart
- **Cross-Platform** - Works on Windows, Linux, and macOS
- **Reverse Proxy** - Optional Caddy integration for automatic HTTPS and routing
- **CLI Interface** - Full-featured command-line tool for management

## Requirements

- Node.js 20+
- npm 9+

## Installation

### Step 1: Clone and Build

```bash
# Clone the repository
git clone https://github.com/your-org/drop.git
cd drop

# Install dependencies
npm install

# Build the project
npm run build
```

### Step 2: Link CLI Globally (Optional)

```bash
npm link
```

This makes the `drop` command available globally.

### Step 3: Verify Installation

```bash
# If you ran npm link
drop version

# Or run directly
node dist/cli/index.js version
```

## Quick Start

### 1. Start the DROP Platform

DROP automatically creates all required directories on first run.

```bash
# Using the CLI (after npm link)
drop serve

# Or run directly
node dist/index.js
```

You should see:
```
[INFO] Starting DROP platform...
[INFO]   Drop root: C:\drop  (or /var/drop on Linux)
[INFO]   Apps directory: C:\drop\webapps
[INFO] DROP platform started successfully
```

### 2. Deploy an Application

While DROP is running, copy your application to the webapps directory:

**Windows:**
```powershell
# Deploy a Node.js app
xcopy my-app C:\drop\webapps\my-app\ /E /I

# Deploy a static site
xcopy my-site C:\drop\webapps\my-site\ /E /I
```

**Linux/macOS:**
```bash
# Deploy a Node.js app
cp -r my-app /var/drop/webapps/

# Deploy a static site
cp -r my-site /var/drop/webapps/
```

### 3. Access Your Application

DROP automatically:
1. Detects the application type
2. Installs dependencies (if needed)
3. Builds the application (if needed)
4. Starts the application
5. Assigns a port (starting from 3001)

Watch the DROP console for output:
```
[INFO] Building my-app...
[INFO] Build completed for my-app in 1500ms
[INFO] Starting my-app on port 3001...
[INFO] Started my-app (PID: 12345)
```

Open your browser: `http://localhost:3001`

## Default Directories

DROP uses platform-appropriate defaults:

| Platform | DROP Root | Webapps Directory |
|----------|-----------|-------------------|
| Windows | `C:\drop` | `C:\drop\webapps` |
| Linux/macOS | `/var/drop` | `/var/drop/webapps` |

All directories are created automatically on startup:
```
C:\drop\                      # DROP_ROOT (Windows)
/var/drop/                    # DROP_ROOT (Linux/macOS)
├── webapps/                  # Your deployed applications
├── data/                     # Platform data (Caddyfile, etc.)
├── logs/                     # Application logs
└── temp/                     # Temporary files
```

## Environment Variables (Optional)

Override defaults with environment variables:

**Windows (PowerShell):**
```powershell
$env:DROP_ROOT = "D:\my-drop"
$env:DROP_APPS_DIR = "D:\my-drop\apps"
$env:DROP_LOG_LEVEL = "debug"
node dist/index.js
```

**Linux/macOS:**
```bash
export DROP_ROOT=/opt/drop
export DROP_APPS_DIR=/opt/drop/apps
export DROP_LOG_LEVEL=debug
node dist/index.js
```

| Variable | Default (Windows) | Default (Linux) | Description |
|----------|-------------------|-----------------|-------------|
| `DROP_ROOT` | `C:\drop` | `/var/drop` | Base directory |
| `DROP_APPS_DIR` | `C:\drop\webapps` | `/var/drop/webapps` | Apps directory |
| `DROP_LOG_LEVEL` | `info` | `info` | Log level: debug, info, warn, error |

## CLI Commands

If you ran `npm link`, you can use the `drop` CLI:

### Start the Platform

```bash
drop serve                   # Start DROP platform
drop serve -r /custom/root   # Custom root directory
drop serve -w /custom/apps   # Custom webapps directory
```

### List Applications

```bash
drop list                    # List running apps
drop list --all              # Include stopped apps
drop list --json             # JSON output
```

### Application Management

```bash
drop status my-app           # Check app status
drop logs my-app             # View logs
drop logs my-app -n 50       # Last 50 lines
drop logs my-app -e          # Error logs only
drop stop my-app             # Stop app
drop start my-app            # Start app
drop restart my-app          # Restart app
drop remove my-app           # Remove app
```

### Deploy via CLI

```bash
drop deploy ./my-app                          # Deploy from path
drop deploy ./my-app --name custom-name       # Custom name
drop deploy ./my-app --port 4000              # Specific port
drop deploy ./my-app -e NODE_ENV=production   # With env vars
```

## Supported Application Types

| Type | Detection | What DROP Does |
|------|-----------|----------------|
| **Node.js** | `package.json` | `npm install` + runs start script |
| **Next.js** | `next.config.*` | `npm install` + `npm run build` + starts |
| **Nuxt** | `nuxt.config.*` | `npm install` + `npm run build` + starts |
| **SvelteKit** | `svelte.config.js` | `npm install` + `npm run build` + starts |
| **Express/Fastify/Hono** | Dependencies in package.json | `npm install` + runs start script |
| **Static Site** | `index.html` | Serves with built-in static server |
| **SPA** | `index.html` + framework | Serves with SPA routing support |
| **Python** | `requirements.txt` | `pip install` + runs app |
| **Docker** | `Dockerfile` | `docker build` + `docker run` |

## Configuration (Optional)

For explicit configuration, create a `drop.yaml` in your app root:

```yaml
name: my-app
type: nodejs

build:
  command: npm run build
  output: dist

start:
  command: node dist/server.js

install:
  command: npm ci --production

port: 3000

env:
  NODE_ENV: production
```

Supported files: `drop.yaml`, `drop.yml`, `drop.json`, `.droprc`

## Example: Deploy Sample Apps

DROP includes sample applications for testing:

**Static Site:**
```powershell
# Windows
xcopy drop-test\sample-static C:\drop\webapps\my-site\ /E /I
```
```bash
# Linux/macOS
cp -r drop-test/sample-static /var/drop/webapps/my-site
```

**Node.js App:**
```powershell
# Windows
xcopy drop-test\sample-nodejs C:\drop\webapps\my-app\ /E /I
```
```bash
# Linux/macOS
cp -r drop-test/sample-nodejs /var/drop/webapps/my-app
```

## Development

```bash
npm run dev          # Start in development mode
npm run build        # Build for production
npm test             # Run tests
npm run lint         # Lint code
npm run format       # Format code
```

## Troubleshooting

### App not detected
- Ensure your app has marker files (`package.json`, `index.html`, etc.)
- Add a `drop.yaml` manifest for explicit configuration

### App won't start
- Check logs: `drop logs my-app -e`
- Verify the start script in `package.json` is correct
- Check if the port is already in use

### Permission denied (Linux/macOS)
```bash
sudo chown -R $USER /var/drop
```

### Debug mode
```bash
# Windows PowerShell
$env:DROP_LOG_LEVEL = "debug"

# Linux/macOS
export DROP_LOG_LEVEL=debug
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DROP Platform                         │
├─────────────┬─────────────┬─────────────┬───────────────┤
│   Watcher   │  Detector   │   Builder   │ Process Mgr   │
│  (chokidar) │  (auto-    │  (npm/pip)  │    (PM2)      │
│             │  detect)    │             │               │
└─────────────┴─────────────┴─────────────┴───────────────┘
        │              │            │             │
        └──────────────┴────────────┴─────────────┘
                         Event Bus
```

1. **Watcher** - Monitors webapps directory for new folders
2. **Detector** - Identifies app type from files (package.json, etc.)
3. **Builder** - Installs dependencies and builds
4. **Process Manager** - Starts and manages processes via PM2

## License

MIT License - see [LICENSE](LICENSE) for details.
