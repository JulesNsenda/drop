# Deploying DROP to Hetzner for Testing

This sets up a persistent Hetzner VPS where every push to `develop` (or the
active v2 feature branch) automatically deploys and restarts DROP. You get a
live URL to hit for testing within ~60 seconds of a push.

---

## Architecture

```
Your machine
    │ git push
    ▼
GitHub Actions
    ├── CI job (lint + build + test)   ← existing ci.yml
    └── Deploy job (SSH → server)      ← new deploy.yml
            │ on: push to develop / feature/DROP-v2*
            ▼
      Hetzner VPS (Ubuntu 24.04)
        /home/drop/drop/              ← git clone
        systemd: drop-platform.service
        DROP API: http://<ip>:3000
        Dashboard: http://<ip>:3000/dashboard
```

---

## Step 1 — Create the Hetzner server

1. Go to [console.hetzner.cloud](https://console.hetzner.cloud).
2. **New project** → e.g. `drop-testing`.
3. **Add server**:
   - Location: pick the nearest (e.g. Nuremberg)
   - Image: **Ubuntu 24.04**
   - Type: **CX22** (2 vCPU, 4 GB RAM — ~€3.79/month; enough for DROP + PG)
   - SSH keys: add your local public key (`~/.ssh/id_ed25519.pub` or similar)
   - Name: `drop-test-1`
4. Click **Create & Buy** → note the server's IP address.

---

## Step 2 — Generate a deploy key

This key is used only by GitHub Actions to SSH into the server.

```bash
# On your local machine
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/drop_deploy -N ""
```

This creates `~/.ssh/drop_deploy` (private) and `~/.ssh/drop_deploy.pub` (public).

---

## Step 3 — Bootstrap the server

SSH in as root using your personal key:

```bash
ssh root@<server-ip>
```

Run the install script — it creates the `drop` system user, installs Node.js
20, clones the repo, builds the server, and sets up the systemd service:

```bash
apt-get update -qq && apt-get install -y curl git build-essential
curl -fsSL https://raw.githubusercontent.com/JulesNsenda/drop/main/install.sh \
  | bash -s -- --root=/home/drop/drop-data
```

The script prints the data directory and a command to retrieve the admin
password once DROP starts.

**Add SSH keys** so you (and GitHub Actions) can log in as the `drop` user:

```bash
mkdir -p /home/drop/.ssh
# Your personal key (lets you SSH in manually):
cat /root/.ssh/authorized_keys >> /home/drop/.ssh/authorized_keys
# GitHub Actions deploy key:
echo "PASTE_DROP_DEPLOY_PUB_KEY_HERE" >> /home/drop/.ssh/authorized_keys
chmod 700 /home/drop/.ssh
chmod 600 /home/drop/.ssh/authorized_keys
chown -R drop:drop /home/drop/.ssh
```

**Replace** `PASTE_DROP_DEPLOY_PUB_KEY_HERE` with the contents of
`~/.ssh/drop_deploy.pub`.

Check DROP started:

```bash
journalctl -u drop-platform -f
# Look for:
#   API server running on http://0.0.0.0:3000
#   Authentication: ENABLED
#   Admin password: <one-time password>  ← copy this
```

The one-time admin password is printed **once** on first boot. It is also
stored at `/home/drop/drop-data/data/drop-svc/api-credentials.json`.

---

## Step 5 — Open the firewall

In Hetzner Cloud Console, go to your server → **Firewalls** → **Create firewall**:

| Rule | Protocol | Port | Source |
|---|---|---|---|
| SSH | TCP | 22 | Your IP (or `0.0.0.0/0` for open) |
| DROP API | TCP | 3000 | `0.0.0.0/0` |
| HTTP | TCP | 80 | `0.0.0.0/0` (if using Caddy) |
| HTTPS | TCP | 443 | `0.0.0.0/0` (if using Caddy) |

Apply the firewall to `drop-test-1`.

Test from your local machine:

```bash
curl http://<server-ip>:3000/api/v1/health
```

Dashboard: `http://<server-ip>:3000/dashboard`

---

## Step 6 — Add GitHub Secrets

In your GitHub repository → **Settings → Secrets and variables → Actions →
New repository secret**:

| Secret name | Value |
|---|---|
| `DEPLOY_HOST` | Your Hetzner server IP |
| `DEPLOY_USER` | `drop` |
| `DEPLOY_KEY` | Contents of `~/.ssh/drop_deploy` (private key, the whole file) |

---

## Step 7 — The deploy workflow is already added

See `.github/workflows/deploy.yml` (committed alongside this guide). It runs
after CI passes on `develop` and on the active v2 feature branch, SSHs into
the server, pulls the latest code, rebuilds, and restarts the service.

To trigger a deployment: push to `develop`.

---

## Daily workflow

```bash
# Make changes locally, run tests
npm test

# Push — CI runs, then deploy runs automatically
git push origin develop

# ~60s later, check the server
curl http://<server-ip>:3000/api/v1/apps
open http://<server-ip>:3000/dashboard
```

### Manual deploy (if you need to force it)

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/JulesNsenda/drop/main/install.sh \
  | bash -s -- --upgrade --branch develop
```

Or step-by-step as the `drop` user:

```bash
ssh drop@<server-ip>
cd /opt/drop
git pull origin develop
npm ci && npm run build:server
sudo systemctl restart drop-platform
journalctl -u drop-platform -f
```

### View live logs

```bash
ssh drop@<server-ip> 'journalctl -u drop-platform -f'
```

---

## Testing DROP features on the server

See `docs/LOCAL-TESTING.md` — the same commands work over SSH. The webapps
directory on the server is `/home/drop/drop-data/data/webapps/`.

```bash
# Deploy a test app from your local machine via SCP
scp -r ./my-test-app drop@<server-ip>:/home/drop/drop-data/data/webapps/

# Or create one directly on the server
ssh drop@<server-ip> '
  mkdir -p ~/drop-data/data/webapps/hello
  echo "<h1>Hello from Hetzner</h1>" > ~/drop-data/data/webapps/hello/index.html
'

# DROP auto-detects it within a few seconds
curl http://<server-ip>:3000/api/v1/apps
```

---

## Teardown

When you're done testing, destroy the server from Hetzner Cloud Console to
stop billing. Your local repo and GitHub are unaffected.

---

## Optional: Docker mode on the server

To test `isolation: docker` (multi-user, containerised apps):

```bash
# On the server as root — install Docker Engine
curl -fsSL https://get.docker.com | sh
usermod -aG docker drop

# Edit the systemd service to add docker isolation
# /etc/systemd/system/drop-platform.service
# Change the ExecStart line:
#   ExecStart=... serve
# Add under [Service]:
#   Environment=DROP_ISOLATION=docker
#   Environment=DROP_ALLOW_SIGNUP=true   # only if you want signup

systemctl daemon-reload && systemctl restart drop-platform
```

DROP will migrate existing apps to containers on first boot in docker mode.
