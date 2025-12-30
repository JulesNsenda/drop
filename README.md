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
- **Reverse Proxy** - Caddy integration for automatic HTTPS and routing
- **CLI Interface** - Full-featured command-line tool for management
- **Event-Driven Architecture** - Extensible plugin system

## Requirements

- Node.js 20+
- npm 9+
- PM2 (installed automatically)
- Caddy (optional, for reverse proxy)

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/your-org/drop.git
cd drop

# Install dependencies
npm install

# Build the project
npm run build

# Link CLI globally
npm link
```

### Verify Installation

```bash
drop version
```

## Quick Start

### 1. Create DROP Directories

```bash
# Linux/macOS
sudo mkdir -p /var/drop/webapps
sudo mkdir -p /var/drop/data
sudo mkdir -p /var/drop/logs

# Windows (run as Administrator)
mkdir C:\drop\webapps
mkdir C:\drop\data
mkdir C:\drop\logs
```

### 2. Set Environment Variables

```bash
# Linux/macOS (add to ~/.bashrc or ~/.zshrc)
export DROP_ROOT=/var/drop
export DROP_APPS_DIR=/var/drop/webapps
export DROP_LOG_LEVEL=info

# Windows (System Environment Variables)
set DROP_ROOT=C:\drop
set DROP_APPS_DIR=C:\drop\webapps
set DROP_LOG_LEVEL=info
```

### 3. Start DROP Platform

```bash
# Start the platform service
node dist/index.js

# Or use the development test runner
npx ts-node drop-test/start-drop.ts
```

### 4. Deploy Your First App

Simply copy your application folder into the webapps directory:

```bash
# Example: Deploy a Node.js app
cp -r my-nodejs-app /var/drop/webapps/

# Windows
xcopy my-nodejs-app C:\drop\webapps\my-nodejs-app\ /E /I
```

DROP will automatically:
1. Detect the application type
2. Install dependencies
3. Build the application (if needed)
4. Start the application
5. Configure routing

## CLI Commands

### Deploy

```bash
# Deploy from current directory
drop deploy

# Deploy from specific path
drop deploy ./my-app

# Deploy with options
drop deploy ./my-app --name my-custom-name --port 3001

# Deploy with environment variables
drop deploy ./my-app -e NODE_ENV=production -e API_KEY=secret

# Skip build step
drop deploy ./my-app --no-build
```

### List Applications

```bash
# List running applications
drop list

# List all applications (including stopped)
drop list --all

# Filter by status
drop list --status online
drop list --status stopped
drop list --status errored

# JSON output
drop list --json
```

### Application Status

```bash
drop status my-app
```

### View Logs

```bash
# View last 100 lines
drop logs my-app

# View specific number of lines
drop logs my-app -n 50

# Show only error logs
drop logs my-app -e
```

### Start/Stop/Restart

```bash
drop start my-app
drop stop my-app
drop restart my-app

# Force stop
drop stop my-app --force
```

### Remove Application

```bash
# Remove application
drop remove my-app

# Force remove without confirmation
drop remove my-app --force

# Remove but keep data
drop remove my-app --keep-data
```

### Global Options

```bash
# JSON output mode (for scripting)
drop --json list

# Quiet mode (suppress non-error output)
drop --quiet deploy ./my-app
```

## Supported Application Types

| Type | Detection | Auto-Config |
|------|-----------|-------------|
| **Node.js** | `package.json` | npm install, npm start |
| **Next.js** | `next.config.*` | npm run build, npm start |
| **Nuxt** | `nuxt.config.*` | npm run build, npm start |
| **SvelteKit** | `svelte.config.js` | npm run build, npm start |
| **Remix** | `remix.config.js` | npm run build, npm start |
| **Astro** | `astro.config.*` | npm run build, npm start |
| **Express** | express dependency | npm start |
| **Fastify** | fastify dependency | npm start |
| **Hono** | hono dependency | npm start |
| **NestJS** | @nestjs/core dependency | npm run build, npm start |
| **Python** | `requirements.txt`, `pyproject.toml` | pip install, python app.py |
| **Django** | django dependency | python manage.py runserver |
| **Flask** | flask dependency | flask run |
| **FastAPI** | fastapi dependency | uvicorn main:app |
| **Go** | `go.mod` | go build, ./app |
| **Rust** | `Cargo.toml` | cargo build, ./target/release/app |
| **Docker** | `Dockerfile` | docker build, docker run |
| **Static** | `index.html` | Served directly |
| **SPA** | `index.html` + JS framework | Served with SPA routing |

## Configuration

### Manifest File (Optional)

For explicit configuration, create a `drop.yaml` (or `drop.json`) in your app root:

```yaml
# drop.yaml
name: my-app
type: nodejs
framework: express

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
  LOG_LEVEL: info

healthCheck:
  path: /health
  interval: 30

domains:
  - myapp.example.com
  - www.myapp.example.com
```

Supported manifest files:
- `drop.yaml` / `drop.yml`
- `drop.json`
- `.droprc` / `.droprc.json` / `.droprc.yaml`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DROP_ROOT` | `/var/drop` | Base installation directory |
| `DROP_APPS_DIR` | `/var/drop/webapps` | Directory for deployed apps |
| `DROP_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `DROP_API_PORT` | `3000` | API server port |

### Platform Configuration

When starting the platform programmatically:

```typescript
import { DropPlatform } from './core/platform';

const platform = new DropPlatform({
  dropRoot: '/var/drop',
  appsDirectory: '/var/drop/webapps',
  logLevel: 'info',
  portRangeStart: 3001,
  portRangeEnd: 3999,
  autoBuild: true,
  autoStart: true,
  caddyfilePath: '/etc/caddy/Caddyfile',
});

await platform.start();
```

## Directory Structure

```
/var/drop/                    # DROP_ROOT
├── webapps/                  # Deployed applications (DROP_APPS_DIR)
│   ├── my-app/
│   ├── another-app/
│   └── static-site/
├── data/                     # Platform data
│   ├── drop.db               # SQLite metadata database
│   └── Caddyfile             # Generated Caddy config
├── logs/                     # Application logs
│   ├── my-app-out.log
│   └── my-app-err.log
└── temp/                     # Temporary files
```

## Development

### Scripts

```bash
# Development mode with hot reload
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format
```

### Project Structure

```
src/
├── cli/                      # CLI commands (Commander.js)
│   ├── commands/             # Individual commands
│   └── utils/                # CLI utilities
├── core/                     # Core services
│   ├── builder/              # Build pipeline
│   ├── detector/             # App type detection
│   ├── event-bus/            # Event system
│   ├── router/               # Caddy configuration
│   ├── watcher/              # File system watcher
│   └── platform.ts           # Main orchestrator
├── managers/                 # Domain managers
│   ├── app/                  # App registry
│   └── process/              # PM2 process management
└── index.ts                  # Entry point
```

### Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- src/core/detector/detector.test.ts

# Watch mode
npm run test:watch
```

## Troubleshooting

### Common Issues

**App not detected:**
- Ensure your app has the correct marker files (package.json, requirements.txt, etc.)
- Add a `drop.yaml` manifest for explicit configuration

**Build fails:**
- Check logs: `drop logs my-app -e`
- Verify all dependencies are listed in package.json/requirements.txt
- Ensure the build command is correct in drop.yaml

**App won't start:**
- Check if the port is already in use
- Verify the start command is correct
- Check for missing environment variables

**Permission denied:**
- Ensure DROP has write access to the webapps directory
- On Linux, you may need to run as root or configure proper permissions

### Debug Mode

Enable debug logging:

```bash
export DROP_LOG_LEVEL=debug
```

## Architecture

DROP uses an event-driven architecture:

1. **Watcher Service** - Monitors the webapps directory for changes
2. **Detector Service** - Identifies application type and framework
3. **Builder Service** - Installs dependencies and builds the app
4. **Process Manager** - Manages app processes via PM2
5. **Router Service** - Configures Caddy for reverse proxy

Events flow through a central event bus, enabling loose coupling and extensibility.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests: `npm test`
5. Commit: `git commit -m "feat: add my feature"`
6. Push: `git push origin feature/my-feature`
7. Create a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [PM2](https://pm2.keymetrics.io/) - Process management
- [Caddy](https://caddyserver.com/) - Reverse proxy with automatic HTTPS
- [Hono](https://hono.dev/) - Lightweight web framework
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [chokidar](https://github.com/paulmillr/chokidar) - File watching
