# Deploying DROP to Hetzner for Testing

Push to `develop` → GitHub Actions builds and tests → auto-deploys to your Hetzner server. Live URL in ~90 seconds.

---

## What you need before starting

- A [Hetzner Cloud](https://console.hetzner.cloud) account
- Your GitHub repo (this one) with Actions enabled
- `ssh-keygen` available on your machine (comes with Git for Windows / macOS / Linux)

---

## Step 1 — Create the server on Hetzner

1. Log in to [console.hetzner.cloud](https://console.hetzner.cloud).
2. Click **New project** → name it `drop-testing` → click **Add server**.
3. Choose these settings:
   - **Location**: pick the closest to you (e.g. Nuremberg)
   - **Image**: Ubuntu 24.04
   - **Type**: CX22 (2 vCPU, 4 GB RAM — costs ~€4/month)
   - **SSH keys**: click **Add SSH key** and paste your local public key (usually at `~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`)
   - **Name**: `drop-test-1`
4. Click **Create & Buy now**.
5. Copy the server's **IP address** from the project dashboard — you'll use it throughout. (203.0.113.10)

---

## Step 2 — Create a deploy key

This is a separate SSH key used only by GitHub Actions to log in to the server. Run this on your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/drop_deploy -N ""
```

This creates two files:
- `~/.ssh/drop_deploy` — the **private** key (goes into GitHub)
- `~/.ssh/drop_deploy.pub` — the **public** key (goes onto the server)

---

## Step 3 — Bootstrap the server

SSH into the server as root (using your personal key from Step 1):

```bash
ssh root@<server-ip>
```

**3a. Install DROP**

Run the install script. It creates a `drop` system user, installs Node.js 20, clones the repo to `/opt/drop`, builds it, and sets up a systemd service that starts on boot:

```bash
apt-get update -qq && apt-get install -y curl git build-essential
curl -fsSL https://raw.githubusercontent.com/JulesNsenda/drop/develop/install.sh \
  | bash -s -- --root=/var/drop
```

> **Note:** The script lives on the `develop` branch until the next merge to `main`. If the curl returns a 404 (e.g. private repo or branch not yet merged), use the manual install below instead.

<details>
<summary>Manual install (if the curl above fails)</summary>

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Create drop user and clone the repo
useradd -m -s /bin/bash drop
git clone --branch develop https://github.com/JulesNsenda/drop.git /opt/drop
cd /opt/drop && npm ci && npm run build:server
chown -R drop:drop /opt/drop
mkdir -p /var/drop && chown -R drop:drop /var/drop

# Create the systemd service
cat > /etc/systemd/system/drop-platform.service << 'EOF'
[Unit]
Description=DROP Platform
After=network.target

[Service]
Type=simple
User=drop
WorkingDirectory=/opt/drop
ExecStart=/usr/bin/node /opt/drop/dist/index.js serve --root=/var/drop
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable drop-platform
systemctl start drop-platform
```

</details>

When it finishes you'll see:
```
✓ DROP installed successfully
  Install directory: /opt/drop
  Data root:         /var/drop
  Service:           drop-platform
```

**3b. Add SSH keys for the `drop` user**

This lets you (and GitHub Actions) log in as the `drop` user:

```bash
mkdir -p /home/drop/.ssh

# Your personal key — lets you SSH in manually
cat /root/.ssh/authorized_keys >> /home/drop/.ssh/authorized_keys

# GitHub Actions deploy key — paste the contents of ~/.ssh/drop_deploy.pub
echo "PASTE_CONTENTS_OF_drop_deploy.pub_HERE" >> /home/drop/.ssh/authorized_keys

chmod 700 /home/drop/.ssh
chmod 600 /home/drop/.ssh/authorized_keys
chown -R drop:drop /home/drop/.ssh
```

To get the public key contents, run this on your local machine:
```bash
cat ~/.ssh/drop_deploy.pub
```

**3c. Allow the `drop` user to manage the service without a password**

GitHub Actions stops the service, unpacks the new build, then starts it again. Add a passwordless sudo rule for those commands:

```bash
echo "drop ALL=(ALL) NOPASSWD: /bin/systemctl stop drop-platform, /bin/systemctl start drop-platform, /bin/systemctl restart drop-platform, /bin/systemctl status drop-platform" \
  > /etc/sudoers.d/drop-deploy
chmod 440 /etc/sudoers.d/drop-deploy
```

**3d. Check DROP started**

```bash
journalctl -u drop-platform -f
```

Look for this line — it contains the one-time admin password:
```
Admin password: <password>   ← copy this, you'll need it to log in
```

The password is also saved at `/var/drop/data/drop-svc/api-credentials.json` if you miss it.

Press `Ctrl+C` to exit the log view.

---

## Step 4 — Open the firewall

In Hetzner Cloud Console → your server → **Firewalls** → **Create firewall**.

Add these inbound rules:

| Name | Protocol | Port | Source |
|---|---|---|---|
| SSH | TCP | 22 | `0.0.0.0/0` |
| DROP API & Dashboard | TCP | 3000 | `0.0.0.0/0` |
| HTTP (optional, for Caddy) | TCP | 80 | `0.0.0.0/0` |
| HTTPS (optional, for Caddy) | TCP | 443 | `0.0.0.0/0` |

Click **Create firewall** and apply it to `drop-test-1`.

**Test it works:**

```bash
curl http://<server-ip>:3000/api/v1/health
# Should return: {"status":"ok", ...}
```

Dashboard: open `http://<server-ip>:3000/dashboard` in your browser.

---

## Step 5 — Create the GitHub environment

The deploy workflow requires a GitHub environment called `hetzner`. Without it the deploy job will be blocked.

1. Go to your GitHub repo → **Settings** → **Environments** → **New environment**.
2. Name it exactly `hetzner`.
3. Click **Configure environment** — no protection rules needed for a test server, just save.

---

## Step 6 — Add GitHub secrets

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add these three secrets:

| Secret name | Value |
|---|---|
| `DEPLOY_HOST` | Your Hetzner server IP (e.g. `65.21.100.42`) |
| `DEPLOY_USER` | `drop` |
| `DEPLOY_KEY_B64` | Your private key **base64-encoded** (see below) |

**Why base64?** Pasting a raw private key into GitHub Secrets on Windows adds Windows line endings (`\r\n`) that corrupt the key. Base64 is a single line with no newlines to corrupt.

To generate the base64-encoded key, run this on your local machine:

```bash
# Git Bash on Windows / Linux
base64 -w 0 ~/.ssh/drop_deploy

# macOS
base64 -i ~/.ssh/drop_deploy
```

Copy the entire output (one long line) and paste it as the `DEPLOY_KEY_B64` secret value.

---

## Step 7 — Push and watch it deploy

The deploy workflow (`.github/workflows/deploy.yml`) is already in the repo. It triggers on every push to `develop` (and `main`), runs lint + build + tests, then SSHes into the server and restarts the service.

Trigger your first deployment:

```bash
git push origin develop
```

Go to **GitHub → Actions** to watch it run. The deploy job appears after the build passes (~60s). Total time from push to live: ~90 seconds.

---

## Daily workflow

```bash
# Make your changes, run tests locally
npm test

# Push — deploys automatically
git push origin develop

# ~90s later, check the server
curl http://<server-ip>:3000/api/v1/apps
# Open the dashboard
open http://<server-ip>:3000/dashboard
```

### Watch live logs

```bash
ssh drop@<server-ip> 'journalctl -u drop-platform -f'
```

### Force a manual deploy

The easiest way is to re-trigger the GitHub Actions workflow without pushing new code:

GitHub repo → **Actions** → pick the last run → **Re-run all jobs**.

Alternatively, if you need to restart the service without redeploying:

```bash
ssh drop@<server-ip> 'sudo systemctl restart drop-platform'
```

---

## Testing DROP on the server

The webapps directory is `/var/drop/data/webapps/`. Anything dropped there is auto-detected and deployed within seconds.

```bash
# Copy a local app to the server
scp -r ./my-app drop@<server-ip>:/var/drop/data/webapps/

# Or create a quick static app directly on the server
ssh drop@<server-ip> '
  mkdir -p /var/drop/data/webapps/hello
  echo "<h1>Hello from Hetzner</h1>" > /var/drop/data/webapps/hello/index.html
'

# Check it was picked up
curl http://<server-ip>:3000/api/v1/apps
```

See `docs/LOCAL-TESTING.md` for more testing patterns — they all work over SSH the same way.

---

## Teardown

When you're done testing, delete the server from Hetzner Cloud Console to stop billing. Your code and GitHub are unaffected.

---

## Troubleshooting

**Deploy job fails with "Permission denied"**
- Check the `DEPLOY_KEY_B64` secret is a single base64 line with no spaces or newlines. Re-run the `base64` command and paste it fresh.
- Confirm `drop_deploy.pub` was added to `/home/drop/.ssh/authorized_keys` on the server.
- Test manually: `ssh -i ~/.ssh/drop_deploy drop@<server-ip> 'echo ok'`

**`sudo systemctl restart` fails**
- Make sure you ran Step 3c to create the sudoers rule.
- Check it exists: `ssh drop@<server-ip> 'sudo systemctl restart drop-platform'`

**Dashboard shows blank / 404**
- The dashboard build may not have run yet. SSH in and run: `cd /opt/drop/src/dashboard && npm ci && npm run build`

**Can't find the admin password**
- `cat /var/drop/data/drop-svc/api-credentials.json`
