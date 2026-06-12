# Local Testing Guide

How to run DROP on your dev machine and exercise the v2.0 features.

---

## Prerequisites

| Requirement | Check |
|---|---|
| Node.js 20+ | `node --version` |
| npm 9+ | `npm --version` |
| Caddy 2+ (optional) | `caddy version` — needed only for hostname routing |
| Docker Engine (optional) | `docker version` — needed only for `isolation: docker` mode |

---

## 1. Build

```bash
# Server only (fast — skips the React dashboard)
npm run build:server

# Full build including dashboard (requires dashboard deps)
cd src/dashboard && npm install && cd ../..
npm run build
```

The compiled output lands in `dist/`.

## 2. Link the CLI globally (one-time)

```bash
npm link
drop --version   # should print 2.0.0-rc.1
```

---

## 3. Start DROP

### Foreground (recommended for testing)

```bash
# Default root: C:\drop (Windows) or /var/drop (Linux)
drop serve

# Use a throw-away root so you don't touch the system directory
drop serve --root ~/drop-test          # Linux/macOS
drop serve --root C:\Users\you\drop-test  # Windows
```

On **first boot** DROP will:
1. Create the directory tree under the root.
2. Start bundled PostgreSQL on port 5433.
3. Create an `admin` user and print the one-time password — **copy it**.
4. Start the REST API on port 3000.
5. Begin watching `<root>/data/webapps/` for apps to deploy.

Dashboard: `http://localhost:3000/dashboard`  
API base:  `http://localhost:3000/api/v1`

### Daemon mode

```bash
drop serve --daemon          # starts in background via PM2
drop server status           # check it's running
drop server stop             # stop it
```

---

## 4. Deploy a test app

Drop any folder into the webapps directory — DROP detects it automatically.

### Static site (instant)

```bash
mkdir ~/drop-test/data/webapps/hello
echo '<h1>Hello DROP</h1>' > ~/drop-test/data/webapps/hello/index.html
```

### Node.js app

```bash
# Copy any Node.js project, or scaffold a minimal one:
mkdir ~/drop-test/data/webapps/myapi
cat > ~/drop-test/data/webapps/myapi/package.json <<'EOF'
{ "name": "myapi", "main": "index.js" }
EOF
cat > ~/drop-test/data/webapps/myapi/index.js <<'EOF'
const http = require('http');
http.createServer((_, res) => res.end('ok')).listen(process.env.PORT);
EOF
```

DROP detects the folder, installs nothing (no `node_modules`), and starts the
server on an auto-assigned port.

### Check deployment status

```bash
drop list             # all apps
drop status hello     # one app
drop logs hello       # stdout/stderr
```

---

## 5. Use the REST API

Replace `<token>` with the admin password printed at startup (or retrieve it):

```bash
# Linux/macOS
TOKEN=$(cat ~/drop-test/data/drop-svc/api-credentials.json \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');
             const u=JSON.parse(d).users.find(u=>u.username==='admin');
             console.log(u?.apiKeys?.[0]?.key ?? 'no-key')")

# Or just hard-code it from the startup output
TOKEN=your-token-here
```

```bash
# List apps
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/apps | node -e "process.stdin|0" 

# Get one app (includes live memory/cpu)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/apps/hello

# Build logs (latest deploy)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/logs/hello/build

# List all build logs
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/logs/hello/builds
```

---

## 6. Test specific v2.0 features

### M5.2 — Build logs

Deploy a Node.js app (needs an install step to generate output):

```bash
mkdir ~/drop-test/data/webapps/withlog
cat > ~/drop-test/data/webapps/withlog/package.json <<'EOF'
{ "name": "withlog", "main": "index.js", "dependencies": { "ms": "*" } }
EOF
echo 'require("http").createServer((_,r)=>r.end("hi")).listen(process.env.PORT)' \
  > ~/drop-test/data/webapps/withlog/index.js
```

After DROP builds it:
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/logs/withlog/build
# Response includes npm ci output in the "log" field
```

### M5.3 — Lockfile-hash install skip

```bash
# Touch only a source file (not package.json / lockfile)
touch ~/drop-test/data/webapps/withlog/index.js

# Watch DROP output — "install" stage should show as skipped
drop logs withlog
```

### M5.1 — Zero-downtime hot-reload

The old process stays running while the new build compiles. To observe:
```bash
# In terminal 1 — poll the app
while true; do curl -s http://localhost:PORT/; sleep 0.5; done

# In terminal 2 — trigger a rebuild
echo '// change' >> ~/drop-test/data/webapps/withlog/index.js

# Terminal 1 should never see a gap (old version keeps responding during build)
```

### M6.1 — Health checks

Add a `drop.yaml` to your app:

```yaml
# ~/drop-test/data/webapps/withlog/drop.yaml
healthCheck: /health
```

Update the app to serve `/health`:

```js
// index.js
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.end('hi');
}).listen(process.env.PORT);
```

DROP will start a health prober that hits `/health` every 30 seconds and
restarts the app after 3 consecutive failures.

### M6.2 — Live CPU/memory stats

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/apps/withlog \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin'));
             console.log('memory:', d.data.memory, 'cpu:', d.data.cpu)"
```

### Multi-user (isolation: docker — Linux only)

```bash
# Requires Docker Engine running
DROP_ISOLATION=docker drop serve --root ~/drop-test-docker

# On first boot, DROP migrates existing PM2 apps to containers.
# Enable signup (requires docker mode + auth):
DROP_ISOLATION=docker DROP_ALLOW_SIGNUP=true drop serve --root ~/drop-test-docker
```

---

## 7. Run the test suite

```bash
npm test                           # all 740 tests
npm test -- --watch                # watch mode
npm test -- src/api/routes/apps    # one file
npm run test:coverage              # coverage report
```

---

## Directory layout after first boot

```
~/drop-test/
├── apps/drop-svc/pgsql/          # bundled PostgreSQL binaries
└── data/
    ├── webapps/                  # ← drop your app folders here
    ├── appdata/<app>/            # per-app persistent data (DROP_DATA_DIR)
    ├── drop-svc/
    │   ├── apps.json             # app state
    │   ├── api-credentials.json  # users + API keys
    │   ├── secrets.json          # encrypted app secrets
    │   └── encryption.key        # master key — back this up
    ├── logs/
    │   ├── drop-svc/             # platform logs
    │   ├── webapps/<app>/        # app stdout/stderr
    │   └── builds/<app>/         # per-deploy build logs (M5.2)
    ├── appconf/
    │   ├── Caddyfile             # managed by DROP (don't hand-edit)
    │   └── webapps/<app>.yaml    # per-app config (port, domains, …)
    └── backup/                   # drop backup output
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `drop: command not found` | Run `npm link` from the project root |
| Port 5433 already in use | Stop any existing PostgreSQL: `pg_ctl stop` or kill the process |
| Port 3000 in use | Set `DROP_API_PORT=3001` before starting |
| App stuck in `building` | Check `drop logs <app>` — likely a build error |
| Dashboard shows no apps | Hard-reload the browser (`Ctrl+Shift+R`) |
| `caddy: not found` on startup | Install Caddy or ignore — hostname routing is optional in `isolation: none` |
| Docker mode fails to start | Ensure Docker Engine is running: `docker info` |

### Reset everything

```bash
drop server stop 2>/dev/null   # stop the daemon if running
rm -rf ~/drop-test             # wipe state
drop serve --root ~/drop-test  # fresh start
```
