#!/usr/bin/env bash
#
# DROP manual rollback — restore the snapshot `remote-deploy.sh` took.
#
# The automatic rollback only fires when the health gate fails. It does not fire
# for the failure this script exists for: a deploy that passes the gate and is
# then found to be bad — a regression that only shows under real traffic, or a
# change an operator wants out before diagnosing it.
#
# Deliberately holds NO privileged verb beyond the closed sudoers list
# (stop / start / restart / status / `--provision`). In particular no
# `daemon-reload`, no `reset-failed`, no `journalctl`: widening that list to make
# a recovery script more convenient is how the list stops being a boundary.
#
# It also never runs `--provision`. That rewrites the systemd unit, Caddy and the
# apex route — infra, not code — and rolling code back through it is the wrong
# order. If infra is what is broken, that is a different operation.
#
# USAGE:  sudo -u drop bash /opt/drop/scripts/deploy/rollback.sh
#
# EXIT CODES:
#    0  rolled back, previous release healthy
#    1  could not roll back, or the restored release is not healthy

set -euo pipefail

readonly DROP_DIR=/opt/drop
readonly SNAPSHOT="${DROP_DIR}/rollback.tar.gz"
readonly LOCK_FILE="${DROP_DIR}/.deploy.lock"
readonly HEALTH_URL=http://localhost:3000/api/v1/health/live
readonly HEALTH_TRIES=30
readonly HEALTH_SLEEP=2

log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ -f "$SNAPSHOT" ]] || die "No snapshot at ${SNAPSHOT} — nothing to roll back to."

# The SAME lock remote-deploy.sh takes. An operator running this while CI is
# mid-deploy would otherwise untar the old release over a half-extracted new
# one, and the two would interleave into a tree that is neither.
exec 9>"$LOCK_FILE"
flock -n 9 || die "A deploy is in progress (${LOCK_FILE} is held) — wait for it to finish."

log "Rolling back to the snapshot taken by the last deploy:"
ls -l "$SNAPSHOT"

sudo systemctl stop drop-platform || true

rm -rf "${DROP_DIR:?}/dist"
tar -xzf "$SNAPSHOT" -C "${DROP_DIR:?}" || die "Could not restore the snapshot. Box state is unknown."

# Dependencies roll back too — restoring code without them is what makes a
# rollback as likely to fail as the deploy it is undoing.
lock_hash=$(sha256sum "${DROP_DIR}/package-lock.json" | cut -d' ' -f1)
prev_hash=$(cat "${DROP_DIR}/node_modules/.deploy-lock-hash" 2>/dev/null || echo none)
if [[ "$lock_hash" != "$prev_hash" ]]; then
  log "Reinstalling dependencies from the restored lockfile"
  npm ci --omit=dev || die "Dependency reinstall failed. Box state is unknown."
  echo "$lock_hash" > "${DROP_DIR}/node_modules/.deploy-lock-hash"
fi

sudo systemctl start drop-platform || true

for ((i = 1; i <= HEALTH_TRIES; i++)); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "Rolled back — the previous release is healthy."
    log ""
    log "NOTE: this restored code and dependencies. It did NOT undo anything the"
    log "bad release already did to tenant apps — see docs/DEPLOY-ROLLBACK.md."
    exit 0
  fi
  sleep "$HEALTH_SLEEP"
done

die "The restored release did not pass the health gate. Box state is unknown."
