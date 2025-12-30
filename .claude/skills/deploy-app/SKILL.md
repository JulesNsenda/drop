---
name: deploy-app
description: Deploy an application to DROP. Use for testing deployment workflow, debugging deployment issues, or demonstrating DROP functionality.
allowed-tools: Bash, Read, Glob
---

# Deploy App Skill

Deploy and manage applications on the DROP platform.

## Deployment Methods

### Method 1: Folder Drop (Recommended)
```bash
# Copy app to webapps directory
cp -r ./my-app /var/drop/data/webapps/my-app

# Or for hostname-based routing
cp -r ./my-app /var/drop/data/webapps/myapp.example.com/ROOT
```

### Method 2: CLI Deployment
```bash
# Deploy from current directory
drop deploy

# Deploy specific folder
drop deploy ./my-app

# Deploy with name
drop deploy --name my-app ./path/to/app

# Deploy to specific host
drop deploy --host myapp.example.com ./path/to/app
```

### Method 3: Git Push
```bash
# Add DROP as remote
git remote add drop drop@server:/var/drop/data/webapps/my-app

# Push to deploy
git push drop main
```

## App Manifest (Optional)

Create `drop.yaml` in app root:
```yaml
name: my-app
type: node
runtime: node:20

build:
  command: npm run build

start:
  command: npm start
  port: 3000

env:
  NODE_ENV: production

database:
  type: postgresql
  version: 16

resources:
  memory: 512M
  cpu: 0.5
```

## Deployment Workflow

```
1. Place folder → Watcher detects
2. Detector analyzes app type
3. Builder runs (npm install, build)
4. Database provisioned (if needed)
5. Process started via PM2
6. Caddy configured for routing
7. SSL certificate obtained
8. App live at URL
```

## Status Commands

```bash
# List all apps
drop list

# Show app status
drop status my-app

# View app logs
drop logs my-app

# Restart app
drop restart my-app

# Stop app
drop stop my-app

# Remove app
drop remove my-app
```

## Debugging

```bash
# Check deployment logs
drop logs my-app --deployment

# View build output
drop logs my-app --build

# Check process status
drop ps my-app

# Inspect app configuration
drop inspect my-app
```

## Common Issues

### Build Fails
- Check `package.json` scripts
- Verify Node.js version compatibility
- Check for missing dependencies

### App Won't Start
- Verify `start` command in manifest
- Check port availability
- Review application logs

### SSL Certificate Issues
- Verify DNS points to server
- Check Caddy logs
- Ensure ports 80/443 accessible
