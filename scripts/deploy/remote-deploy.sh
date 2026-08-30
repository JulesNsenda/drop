#!/usr/bin/env bash
#
# DROP remote deploy — the sequence that used to be an inline `ssh` heredoc.
#
# WHY THIS IS A FILE (Landing C of the CI/CD redesign)
#
# `ssh host 'multi-line script'` is re-parsed by the remote LOGIN shell, so the
# quoting that looks correct in the workflow is not what protects the script.
# One stray apostrophe anywhere in it — including in a comment — closes the
# argument early and the rest executes as separate ssh words, silently, halfway
# through a deploy that has already stopped the service. `deploy.yml` carried a
# hand-written apostrophe-counting guard for exactly that reason (DROP-074), and
# a comment explaining that shellcheck cannot see the problem at all.
#
# As a file it is shellcheck-clean, smoke-tested in a container before it ever
# runs against production (scripts/deploy/smoke-test.sh), and shipped INSIDE the
# verified artifact — not fetched by adding `actions/checkout` to the
# key-holding deploy job, which would both widen that job and run a branch's
# copy of this script on production rather than the copy CI verified.
#
# USAGE (from deploy.yml, over ssh):
#   remote-deploy.sh <shipped-install-sha256> <staged-tarball>
#
# EXIT CODES — the notification depends on telling these apart:
#    0  deployed and healthy
#   10  deploy failed, ROLLED BACK, previous release is healthy
#    1  failed and the box state is UNKNOWN (rollback itself failed, or a
#       precondition was not met before anything was touched)

set -euo pipefail

readonly DROP_DIR=/opt/drop
readonly SNAPSHOT="${DROP_DIR}/rollback.tar.gz"
readonly LOCK_FILE="${DROP_DIR}/.deploy.lock"
readonly HEALTH_URL=http://localhost:3000/api/v1/health/live
# 60s, matching the platform's own readiness gate (DROP-063 widened it from 20s
# to 60s and a shorter gate here would fail good builds on a slow boot).
readonly HEALTH_TRIES=30
readonly HEALTH_SLEEP=2

log()  { printf '%s\n' "$*"; }
warn() { printf '::warning::%s\n' "$*"; }
die()  { printf '%s\n' "$*" >&2; exit 1; }

# ── argument validation, before anything else ────────────────────────────────
#
# FIRST, because `ssh host cmd arg` is re-parsed by the remote login shell:
# local quoting in the workflow does not protect these values. deploy.yml
# triggers on `feature/DROP-v2*`, and a branch name is attacker-influenced, so
# nothing derived from `github.ref_name` may reach this command line unchecked.
# A sha256 is 64 hex characters; anything else is refused before a single
# destructive statement runs.
SHIPPED_HASH="${1:-}"
STAGED_TARBALL="${2:-}"

[[ "$SHIPPED_HASH" =~ ^[0-9a-f]{64}$ ]] \
  || die "refusing to deploy: first argument is not a sha256 digest"
[[ "$STAGED_TARBALL" =~ ^/[A-Za-z0-9._/-]+\.tar\.gz$ ]] \
  || die "refusing to deploy: second argument is not a plausible tarball path"
[[ -f "$STAGED_TARBALL" ]] \
  || die "refusing to deploy: staged tarball ${STAGED_TARBALL} not found"

# ── serialize against rollback.sh ────────────────────────────────────────────
#
# A manual `rollback.sh` run and an automatic deploy both untar into ${DROP_DIR}
# and restart the service. Interleaving them can leave `dist/` from one and the
# dependency-lock witness from the other. `concurrency: deploy` in the workflow
# serializes deploys against each other; it knows nothing about an operator at
# an ssh prompt.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy or rollback holds ${LOCK_FILE} — refusing to run concurrently"

cd "${DROP_DIR:?}"

# ── snapshot, before destroying anything ─────────────────────────────────────
#
# `dist/` and `package-lock.json` are what a rollback needs: the code, and the
# lockfile that says which node_modules go with it. Restoring code WITHOUT its
# dependencies is what makes a rollback as likely to fail as the deploy it is
# undoing.
#
# Taken before the stop, so a failure here costs nothing — the service is still
# serving the release we would have rolled back to.
snapshot_previous() {
  if [[ ! -d dist ]]; then
    # First deploy onto a fresh box. There is no previous release to keep, and
    # a rollback later must NOT restore an empty one, so the marker is the
    # absence of the file.
    rm -f "${SNAPSHOT:?}"
    log "No previous dist/ — nothing to snapshot (first deploy)"
    return 0
  fi
  tar -czf "${SNAPSHOT:?}.partial" dist package-lock.json
  mv "${SNAPSHOT:?}.partial" "${SNAPSHOT:?}"
  log "Snapshotted previous release to ${SNAPSHOT}"
}

# ── dependency install, conditional on the lockfile actually changing ────────
#
# `npm ci` wipes and rebuilds node_modules from scratch, which means compiling
# native bcrypt on a 4 GB box while the service is already stopped. Skip it when
# the lockfile is byte-identical to the one installed last deploy.
#
# The witness lives INSIDE node_modules on purpose: `npm ci` removes that whole
# tree before installing, so the witness cannot outlive the tree it describes.
# An interrupted or failed install therefore leaves no witness and the next
# deploy installs — where a witness kept beside package.json would have survived
# and been trusted.
install_dependencies() {
  [[ -f package-lock.json ]] || die "package-lock.json missing from artifact"
  local lock_hash prev_hash
  lock_hash=$(sha256sum package-lock.json | cut -d' ' -f1)
  prev_hash=$(cat node_modules/.deploy-lock-hash 2>/dev/null || echo none)

  if [[ "$lock_hash" == "$prev_hash" ]]; then
    log "Dependencies unchanged — skipping npm ci"
    return 0
  fi
  npm ci --omit=dev
  echo "$lock_hash" > node_modules/.deploy-lock-hash
}

# ── system provisioning ──────────────────────────────────────────────────────
#
# Re-apply Caddy, the systemd unit, env and the apex route so infra changes in
# install.sh land on the server. This also restarts the service.
#
# Preferred target is the root-owned /usr/local/sbin/drop-provision (DROP-071) —
# a copy of install.sh OUTSIDE /opt/drop, which is chowned to the drop user and
# therefore not something root should ever execute. The middle arm is legacy: a
# box bootstrapped before DROP-071 only has a sudoers rule for
# /opt/drop/install.sh, and running --provision through it seeds
# /usr/local/sbin/drop-provision and rewrites the sudoers rule, so the very next
# deploy takes the first branch. Until the box has been provisioned at least
# once either way, fall back to a plain restart so the deploy still ships code.
#
# The interpreter is pinned to an absolute /usr/bin/bash and MUST match the
# write_sudoers rule in install.sh BYTE FOR BYTE (interpreter + path + args) or
# sudo refuses and this silently falls through to the legacy arm. Pinning
# matters: executing the script directly would honour its `#!/usr/bin/env bash`
# shebang, and sudo's secure_path starts with /usr/local/sbin:/usr/local/bin —
# the latter root:staff 2775 on stock Debian, so `bash` could resolve to
# something other than the real interpreter.
apply_provisioning() {
  if sudo -n /usr/bin/bash /usr/local/sbin/drop-provision --provision; then
    log "System provisioning applied"
  elif sudo -n /usr/bin/bash /opt/drop/install.sh --provision; then
    log "System provisioning applied (legacy sudoers rule — the next deploy will use /usr/local/sbin/drop-provision)"
  else
    warn "Provisioning unavailable — falling back to restart. Bootstrap install.sh on the server to enable self-provisioning."
    sudo systemctl restart drop-platform
  fi
}

# ── provisioning staleness ───────────────────────────────────────────────────
#
# `--provision` alone only re-applies whatever logic was last installed into
# /usr/local/sbin/drop-provision. Compare it against the install.sh just
# untarred, so an infra change that shipped in THIS deploy but silently did not
# take effect is visible instead of the box quietly diverging from the repo.
#
# A DETECTION AID ONLY, deliberately unauthenticated — a plain sha256sum
# comparison, no secret involved. It proves nothing about trust: an actor who
# could forge one side could already do worse. Never read a match as "the box is
# provisioned correctly", and never build an authorization decision on it.
#
# `$SHIPPED_HASH` is computed on the RUNNER, straight out of the CI-built
# tarball, and passed in. Recomputing it here from /opt/drop/install.sh would
# let the drop user — who owns that file — rewrite it between the untar and this
# line, making both sides match and permanently silencing the signal.
#
# Non-fatal: a stale-but-working box is not an outage, and failing here would
# block shipping application code over unrelated infra drift.
check_provision_staleness() {
  [[ -x /usr/local/sbin/drop-provision ]] || return 0
  local installed_hash
  installed_hash=$(sha256sum /usr/local/sbin/drop-provision | cut -d' ' -f1)
  [[ "$SHIPPED_HASH" == "$installed_hash" ]] && return 0
  warn "The install.sh shipped in this deploy differs from /usr/local/sbin/drop-provision — provisioning changes (systemd unit, Caddy, sudoers, apex route) have NOT been applied. Remediate by copying a TRUSTED install.sh to the box and running it as root via ssh: bash /tmp/install.sh --bootstrap. Do NOT run /opt/drop/install.sh as root — it is writable by the drop user, which is the exact primitive DROP-071 removes."
}

# ── health gate ──────────────────────────────────────────────────────────────
#
# Probe /health/live, which is unconditionally 200 when the process is serving.
# /api/v1/health returns 503 whenever the PM2 or Postgres probe is down, which a
# slow boot does routinely.
#
# Returns non-zero rather than exiting, because the caller has to decide between
# "roll back" and "give up". Deliberately NO automatic dependency reinstall on
# failure: `npm ci` removes node_modules before installing, so a reinstall that
# then fails (an OOM compiling bcrypt on a 4 GB box is the realistic case) would
# leave the box with no dependencies at all, crash-looping on MODULE_NOT_FOUND
# under Restart=on-failure.
health_gate() {
  local i
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      log "Health check passed"
      return 0
    fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

# ── rollback ─────────────────────────────────────────────────────────────────
#
# EXACTLY ONE ATTEMPT, with an explicit terminal state on every path.
#
# Two constraints that are easy to get wrong and both matter:
#
#  - `set -e` does NOT apply inside a function called from an `if`, `||` or `&&`
#    context — which is the natural way to write "gate failed, roll back". Every
#    path here therefore returns an explicit status; nothing relies on `set -e`.
#  - NEVER re-run `--provision` during a rollback. It restarts the service and
#    rewrites the unit, Caddy and the apex route from $PROVISION_BIN. That is
#    infra, not code, and rolling code back through it is the wrong order.
#
# A slow boot can fail the gate for a GOOD build, in which case the rollback's
# own gate fails identically. That branch is a real outcome, not an oversight:
# it exits 1, "state unknown", which is the honest answer.
rollback() {
  if [[ ! -f "$SNAPSHOT" ]]; then
    log "No snapshot to roll back to (first deploy) — leaving the box as-is" >&2
    return 1
  fi

  log "Health gate failed — rolling back to the previous release"
  sudo systemctl stop drop-platform || true

  rm -rf "${DROP_DIR:?}/dist"
  if ! tar -xzf "$SNAPSHOT" -C "${DROP_DIR:?}"; then
    log "Rollback FAILED: could not restore the snapshot. Box state is unknown." >&2
    return 1
  fi

  # Dependencies roll back too. The restored lockfile is authoritative: if it
  # differs from what is installed, the installed tree belongs to the release
  # being undone.
  local lock_hash prev_hash
  lock_hash=$(sha256sum "${DROP_DIR}/package-lock.json" | cut -d' ' -f1)
  prev_hash=$(cat "${DROP_DIR}/node_modules/.deploy-lock-hash" 2>/dev/null || echo none)
  if [[ "$lock_hash" != "$prev_hash" ]]; then
    log "Reinstalling dependencies from the restored lockfile"
    if ! npm ci --omit=dev; then
      log "Rollback FAILED: dependency reinstall failed. Box state is unknown." >&2
      return 1
    fi
    echo "$lock_hash" > "${DROP_DIR}/node_modules/.deploy-lock-hash"
  fi

  sudo systemctl start drop-platform || true

  if health_gate; then
    log "Rolled back — the previous release is healthy"
    return 0
  fi
  log "Rollback restored the previous release but it did NOT pass the health gate. Box state is unknown." >&2
  return 1
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  snapshot_previous

  sudo systemctl stop drop-platform
  rm -rf "${DROP_DIR:?}/dist" "${DROP_DIR:?}/install.sh"
  tar -xzf "$STAGED_TARBALL" -C "${DROP_DIR:?}"
  install_dependencies
  rm -f "${STAGED_TARBALL:?}"

  apply_provisioning
  check_provision_staleness

  if health_gate; then
    log "Deploy complete"
    exit 0
  fi

  # `if rollback; then` is the one place `set -e` is suspended, which is why
  # rollback() returns explicitly on every path rather than trusting it.
  if rollback; then
    exit 10
  fi
  exit 1
}

main
