# DROP

**Deploy, Run, Operate, Publish** | v0.1.0

A lightweight, self-hosted Platform as a Service (PaaS) engineered for the "drop folder and deploy" workflow. Zero-configuration deployment for Node.js, Python, static sites, and containerized applications.

## Philosophy

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

## Features

- **Zero-Config Deployment** - Auto-detects app type, builds, and starts automatically
- **Hot Reload** - Edit files and your app rebuilds/restarts automatically
- **PostgreSQL Auto-Provisioning** - Apps get their own database with `DATABASE_URL` injected
- **Port Persistence** - Apps keep the same port across restarts
- **Multi-Runtime Support** - Node.js, Python, Docker, static sites
- **Framework Detection** - Recognizes Next.js, Nuxt, Express, FastAPI, Flask, and more
- **Process Management** - Built on PM2 for reliable process management with auto-restart
- **REST API** - Full API with JWT and API key authentication
- **Cross-Platform** - Works on Windows, Linux, and macOS
- **CLI Interface** - Full-featured command-line tool for management

## Requirements

- Node.js 20+
- npm 9+

## Quick Start

### 1. Install

```bash
git clone https://github.com/techamat/drop.git
cd drop
npm install
npm run build
npm link  # Makes 'drop' command available globally
```

### 2. Start DROP

```bash
drop serve
```

You'll see:
```
[DROP] Starting DROP platform...
[DROP]   Apps directory: C:\drop\data\webapps
[DROP] DROP platform started successfully
```

### 3. Deploy an App

Copy any app folder to the webapps directory:

```bash
# Windows
xcopy my-app C:\drop\data\webapps\my-app\ /E /I

# Linux/macOS
cp -r my-app /var/drop/data/webapps/
```

DROP automatically:
1. Detects the app type (Node.js, Python, static, etc.)
2. Installs dependencies
3. Builds the app
4. Provisions a PostgreSQL database (if needed)
5. Starts the app on an assigned port

### 4. Access Your App

```
http://localhost:3001
```

### 5. Edit and Hot-Reload

Edit any file in your app - DROP detects changes and automatically rebuilds/restarts.

## CLI Commands

```bash
# Platform
drop serve                # Start DROP platform
drop serve -d             # Start as background daemon
drop serve -r /custom     # Custom root directory

# Applications
drop list                 # List running apps
drop list --all           # Include stopped apps
drop status my-app        # Check app status
drop logs my-app          # View logs
drop logs my-app -n 50    # Last 50 lines

# Management
drop stop my-app          # Stop app
drop start my-app         # Start app
drop restart my-app       # Restart app
drop remove my-app        # Remove app

# Deploy
drop deploy ./my-app                    # Deploy from path
drop deploy ./my-app --name custom      # Custom name
drop deploy ./my-app --port 4000        # Specific port
```

## Supported App Types

| Type | Detection | What DROP Does |
|------|-----------|----------------|
| **Node.js** | `package.json` | `npm install` + runs start script |
| **Next.js** | `next.config.*` | `npm install` + `npm run build` + starts |
| **Express/Fastify/Hono** | Dependencies | `npm install` + runs start script |
| **Static Site** | `index.html` | Serves with built-in static server |
| **SPA** | `index.html` + framework | Serves with SPA routing support |
| **Python** | `requirements.txt` | `pip install` + runs app |
| **Docker** | `Dockerfile` | `docker build` + `docker run` |

## Database Auto-Provisioning

Apps that need a database get one automatically. DROP:
1. Detects database dependencies (pg, mysql, prisma, etc.)
2. Provisions a PostgreSQL database
3. Injects `DATABASE_URL` environment variable

Your app just connects:
```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

## REST API

DROP includes a REST API for programmatic control:

```bash
# List apps
curl http://localhost:3000/api/apps

# Get app status
curl http://localhost:3000/api/apps/my-app

# Deploy (with API key)
curl -X POST http://localhost:3000/api/apps \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "path": "/path/to/app"}'
```

## Directory Structure

```
C:\drop\                     # Windows (or /var/drop on Linux)
├── data/
│   ├── webapps/             # Your deployed apps (watched)
│   ├── drop-svc/            # Platform state
│   ├── appconf/
│   │   └── webapps/         # Per-app config files
│   └── logs/                # All logs
```

## Configuration (Optional)

For explicit configuration, create `drop.yaml` in your app:

```yaml
name: my-app
type: nodejs

build:
  command: npm run build

start:
  command: node dist/server.js

env:
  NODE_ENV: production
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DROP_ROOT` | `C:\drop` or `/var/drop` | Base directory |
| `DROP_APPS_DIR` | `{root}/data/webapps` | Apps directory |
| `DROP_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

## Development

```bash
npm run dev          # Start in development mode
npm run build        # Build for production
npm test             # Run tests (390 tests)
npm run lint         # Lint code
npm run format       # Format code
```

## Roadmap

- [ ] Caddy reverse proxy integration (hostnames like `myapp.localhost`)
- [ ] Automatic HTTPS with Let's Encrypt
- [ ] Web dashboard UI
- [ ] Multi-node clustering

## License

MIT License - see [LICENSE](LICENSE) for details.
