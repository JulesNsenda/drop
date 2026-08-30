# Docker isolation — what contains a tenant app, and what does not

DROP runs tenant code one of two ways, decided once at startup by
`DROP_ISOLATION` (or `--isolation`):

| Mode | Tenant code runs as | Multi-user |
|---|---|---|
| `none` (default) | a host process under PM2, as the `drop` user | not permitted |
| `docker` | a container on the `drop-net` bridge | permitted |

The dashboard reports which one this box is running under **Settings →
Configuration → Isolation**, along with what it takes to change it. It cannot be
changed while the platform is running: DROP selects its app-runtime
implementation once at boot, and existing apps move between the two with
`drop migrate-runtime`.

Everything below applies to `docker` mode only.

---

## Two tiers, and which one you are on

The isolation work was deliberately split, because the two cohorts need
different things:

- **Tier A** — safe against *buggy* tenant code. Resource caps, non-root
  containers, a loopback-only port publish, an enforced image allowlist, and a
  Postgres socket mount that keeps the database off TCP. Shipped 2026-06-19.
- **Tier B** — safe against *malicious* tenant code. Required before untrusted
  people (a public signup, a waitlist cohort you have not vetted) deploy to the
  box.

Tier B is not one switch. Most of it is enforced by DROP and is on
automatically; two controls belong to the Docker daemon and are the operator's.

### What DROP enforces for you

Applied to every container, and not overridable from `drop.yaml` or the API:

| Control | What it stops |
|---|---|
| `--cap-drop ALL` | every Linux capability, including `CAP_SYS_ADMIN` |
| `no-new-privileges` | a setuid binary inside the image escalating |
| non-root `User` per image | the process starting life as uid 0 |
| **read-only root filesystem** | writing a binary to `/usr/local/bin` or rewriting `/etc` |
| **tmpfs for `/tmp`, `/run`, `/var/run`, `/var/cache/nginx`** | those writes still working, without giving back an executable surface — each is `noexec,nosuid,nodev` and size-capped |
| **digest-pinned base images** | the image behind `node:20-slim` changing under you between two boxes or two days |
| **fixed `/data` mount** | the host's directory layout and DROP's root location being visible inside the container |
| loopback-only port publish | an app reaching the internet without passing Caddy |
| `drop-net` with ICC disabled | one tenant container talking to another |
| **control-plane origin gate** | a container reaching `/auth/login`, `/oauth/*`, `/app-access/*`, `/mcp` or the dashboard |

The bold rows are DROP-160.

### What you have to do yourself

These are daemon-level. DROP **reports** them at startup — look for a
`SECURITY` line in the platform log — but cannot apply them.

#### 1. `userns-remap` (the important one)

Without it, container root **is** host root. Every per-container control above
is a wall in front of that fact rather than a replacement for it: a runc or
kernel escape from a tenant container lands as real root on your host.
`userns-remap` maps container root to an unprivileged host UID, so the same
escape lands as `nobody`.

The installer can turn it on:

```bash
sudo bash install.sh --provision --isolation=docker --userns-remap
```

It is **opt-in and never implied by `--isolation=docker`**, because on a box
that is already running it is disruptive:

- the daemon restarts, stopping every container;
- image and container storage moves to a remapped root — existing images and
  containers are not migrated, they become *invisible*, and everything must be
  pulled and recreated;
- a bind-mounted host directory is now accessed as the remapped UID.

That last point is the sharp edge on an existing fleet. DROP's per-app data
directories are owned for the in-container user, and remapping shifts what that
user *is* — so plan the ownership change before you turn it on, or apps will
start and then fail their first write.

If `/etc/docker/daemon.json` already exists, the installer refuses to rewrite
it and tells you to add the key by hand. That file may carry registry mirrors,
log drivers or storage settings, and merging JSON in bash is how an engine ends
up not starting:

```json
{ "userns-remap": "default" }
```

Then `systemctl restart docker` and confirm with
`docker info --format '{{json .SecurityOptions}}'` — you want `name=userns` in
the output.

#### 2. seccomp

Docker applies its default syscall filter unless the daemon is configured
otherwise. DROP does not override it, and warns at startup if it finds
`seccomp` reported as `unconfined`. If you see that warning, something on this
host has turned it off; that is not a DROP setting.

---

## Refreshing the pinned base images

Pinning means a base image no longer picks up its publisher's security
rebuilds. That is the point — an image change becomes a reviewed commit rather
than a silent one — but it makes the digest table a maintenance obligation. A
stale pin is a known-CVE base image, which is its own risk in the other
direction.

To refresh:

```bash
docker buildx imagetools inspect node:20-slim   # → Digest: sha256:…
```

Use `buildx imagetools`, **not** `docker manifest inspect -v`. The latter
reports the digest of the platform manifest your local daemon resolved to,
which would pin every self-hoster to your architecture. `imagetools` reports the
index digest, which resolves correctly on arm64 and amd64 alike.

Update `IMAGE_DIGESTS` in `src/managers/runtime/container-config.ts` **and** the
pre-pull list in `install.sh` — a test fails the build if the two disagree.

A refresh changes `containerPolicyFingerprint`, so every docker-mode app is
redeployed once on the next boot. That is intended: recreating the container is
the only way a new base image reaches an already-running app.

`DROP_DISABLE_IMAGE_PINNING=true` falls back to bare tags. It exists for an
operator on a private mirror that does not carry these digests — a wrong pin
refuses every deploy on the box, and "edit the source and rebuild" is not an
acceptable recovery path.

---

## The control plane and your apps

DROP's API binds `0.0.0.0` by default, because an app granted control-plane
capabilities reaches it at `drop-host:<apiPort>` — the `drop-net` gateway, which
is a host interface, not loopback.

If **no app on this box holds control-plane capabilities** (check with
`GET /api/v1/apps/<name>/capabilities`), bind it to loopback instead:

```
DROP_API_HOST=127.0.0.1
```

Caddy and the CLI both run on the host, so nothing else needs the bridge. This
is the strong form.

If an app does need the API, leave the default. The origin gate refuses
credential and browser-facing surfaces to any caller inside `drop-net`, which is
defence in depth behind the ordinary authentication — not a substitute for the
loopback bind.

---

## Reading the startup log

On a `docker`-mode boot you should see, under `SECURITY`:

```
Docker userns-remap is active — container root maps to an unprivileged host UID
```

If instead you see:

```
Docker userns-remap is NOT active: a container escape would land as real root on the host.
```

then Tier B is incomplete on this host, and untrusted tenants should not be
deploying to it yet. The warning never blocks a boot — it is a statement about
your host's configuration, and a platform that refused to start over it would be
unbootable on exactly the boxes that most need to see it.
