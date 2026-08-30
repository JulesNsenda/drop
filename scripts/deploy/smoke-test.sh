#!/usr/bin/env bash
#
# Exercise remote-deploy.sh against a fake /opt/drop, with systemctl, sudo, curl
# and npm stubbed.
#
# This is the ONLY thing that runs the deploy script before it runs against
# production for real. `shellcheck` proves it parses; it cannot prove the
# sequence is right, that the rollback restores what it claims, or that a second
# run is idempotent — and those are exactly the properties whose absence is
# discovered at 2am with the service stopped.
#
# Runs in a Debian container in CI (see _verify.yml). Run it locally the same
# way:
#
#   docker run --rm -v "$PWD":/repo -w /repo debian:12-slim \
#     bash scripts/deploy/smoke-test.sh
#
# Every assertion is on the END STATE, not on log lines — a script that prints
# "Deploy complete" while leaving the wrong tree is exactly the failure this is
# guarding against.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
readonly REPO_ROOT
WORK=$(mktemp -d)
readonly WORK
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

check() {
  local what=$1 expected=$2 actual=$3
  if [[ "$expected" == "$actual" ]]; then
    printf '  ok   %s\n' "$what"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$what" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── the fake box ─────────────────────────────────────────────────────────────
#
# `remote-deploy.sh` hardcodes /opt/drop, which is correct — a configurable root
# would be one more thing to get wrong on the real box, for the benefit of a
# test. So the test creates the real path inside a throwaway container instead.
setup_box() {
  rm -rf /opt/drop
  mkdir -p /opt/drop/dist /opt/drop/node_modules
  echo "OLD BUILD" > /opt/drop/dist/marker
  echo '{"lockfileVersion":3,"name":"old"}' > /opt/drop/package-lock.json
  sha256sum /opt/drop/package-lock.json | cut -d' ' -f1 > /opt/drop/node_modules/.deploy-lock-hash
  echo "old install" > /opt/drop/install.sh
}

# Build the artifact the deploy untars: a new dist/, a new install.sh, and a
# lockfile that DIFFERS from the installed one so the npm-ci branch is taken.
make_tarball() {
  local staged=$1 lock=${2:-'{"lockfileVersion":3,"name":"new"}'}
  local build="$WORK/build"
  rm -rf "$build"
  mkdir -p "$build/dist"
  echo "NEW BUILD" > "$build/dist/marker"
  echo "new install" > "$build/install.sh"
  printf '%s' "$lock" > "$build/package-lock.json"
  tar -czf "$staged" -C "$build" dist install.sh package-lock.json
}

# ── stubs ────────────────────────────────────────────────────────────────────
#
# Recorded to a log the assertions read, so "did it stop the service before
# untarring" is a checkable fact rather than a hope.
install_stubs() {
  local health=$1   # pass | fail | fail-then-pass
  mkdir -p "$WORK/bin"
  : > "$WORK/calls.log"
  echo "$health" > "$WORK/health-mode"
  : > "$WORK/health-count"

  cat > "$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
echo "systemctl $*" >> "$SMOKE_WORK/calls.log"
exit 0
STUB

  # `sudo -n <cmd>` must run the command; the provisioning arms are what decide
  # whether the script takes the preferred, legacy or fallback path.
  cat > "$WORK/bin/sudo" <<'STUB'
#!/bin/sh
echo "sudo $*" >> "$SMOKE_WORK/calls.log"
[ "$1" = "-n" ] && shift
# No drop-provision on this fake box, so the first two arms fail and the script
# falls back to a restart — the same shape a not-yet-bootstrapped server has.
case "$*" in
  */drop-provision*|*/install.sh*) exit 1 ;;
esac
exec "$@"
STUB

  cat > "$WORK/bin/npm" <<'STUB'
#!/bin/sh
echo "npm $*" >> "$SMOKE_WORK/calls.log"
# `npm ci` removes node_modules before installing — reproduced, because the
# lock-hash witness living INSIDE that tree is load-bearing.
if [ "$1" = "ci" ]; then
  rm -rf /opt/drop/node_modules
  mkdir -p /opt/drop/node_modules
fi
exit 0
STUB

  cat > "$WORK/bin/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >> "$SMOKE_WORK/calls.log"
mode=$(cat "$SMOKE_WORK/health-mode")
n=$(wc -c < "$SMOKE_WORK/health-count")
printf 'x' >> "$SMOKE_WORK/health-count"
case "$mode" in
  pass) exit 0 ;;
  fail) exit 7 ;;
  # The rollback path: the deploy's gate fails, the rollback's gate passes.
  # 30 tries at HEALTH_TRIES, so anything past that is the second gate.
  fail-then-pass) [ "$n" -ge 30 ] && exit 0; exit 7 ;;
esac
exit 7
STUB

  chmod +x "$WORK"/bin/*
}

run_deploy() {
  local staged=$1 hash=${2:-$(printf '0%.0s' $(seq 64))}
  set +e
  SMOKE_WORK="$WORK" PATH="$WORK/bin:$PATH" \
    bash "$REPO_ROOT/scripts/deploy/remote-deploy.sh" "$hash" "$staged" \
    > "$WORK/out.log" 2>&1
  local rc=$?
  set -e
  return $rc
}

# ── cases ────────────────────────────────────────────────────────────────────

echo "happy path"
setup_box; install_stubs pass; make_tarball "$WORK/drop-dist.tar.gz"
run_deploy "$WORK/drop-dist.tar.gz" && rc=0 || rc=$?
check "exits 0" "0" "$rc"
check "new build is in place" "NEW BUILD" "$(cat /opt/drop/dist/marker)"
check "staged tarball is cleaned up" "absent" "$([[ -e $WORK/drop-dist.tar.gz ]] && echo present || echo absent)"
check "snapshot of the previous release exists" "present" "$([[ -f /opt/drop/rollback.tar.gz ]] && echo present || echo absent)"
check "service was stopped before the untar" "yes" \
  "$(grep -q 'systemctl stop drop-platform' "$WORK/calls.log" && echo yes || echo no)"
check "npm ci ran, because the lockfile changed" "yes" \
  "$(grep -q 'npm ci --omit=dev' "$WORK/calls.log" && echo yes || echo no)"
check "lock witness was written" "present" \
  "$([[ -f /opt/drop/node_modules/.deploy-lock-hash ]] && echo present || echo absent)"

echo "idempotency — a second, identical run"
install_stubs pass; make_tarball "$WORK/drop-dist.tar.gz"
run_deploy "$WORK/drop-dist.tar.gz" && rc=0 || rc=$?
check "exits 0 again" "0" "$rc"
check "still the new build" "NEW BUILD" "$(cat /opt/drop/dist/marker)"
check "npm ci SKIPPED — the lockfile is unchanged" "no" \
  "$(grep -q 'npm ci --omit=dev' "$WORK/calls.log" && echo yes || echo no)"

echo "rollback — the health gate fails"
setup_box; install_stubs fail-then-pass; make_tarball "$WORK/drop-dist.tar.gz"
run_deploy "$WORK/drop-dist.tar.gz" && rc=0 || rc=$?
# 10 means "rolled back, previous release healthy" — distinct from 1, because
# the notification has to tell an operator which of those two happened.
check "exits 10, not 1" "10" "$rc"
check "the OLD build is back" "OLD BUILD" "$(cat /opt/drop/dist/marker)"
# EXACTLY once: the deploy's own call, and none from the rollback.
# `--provision` restarts the service and rewrites the unit, Caddy and the apex
# route — infra, not code — so rolling code back through it is the wrong order.
# A count of 2 would mean the rollback did it too.
check "rollback did not re-run --provision" "1"   "$(grep -c 'drop-provision --provision' "$WORK/calls.log")"

echo "rollback is impossible — first deploy onto a bare box"
rm -rf /opt/drop; mkdir -p /opt/drop
install_stubs fail; make_tarball "$WORK/drop-dist.tar.gz"
run_deploy "$WORK/drop-dist.tar.gz" && rc=0 || rc=$?
# 1, not 10: there is no previous release, so "rolled back and healthy" would be
# a lie. State unknown is the honest answer.
check "exits 1 when there is nothing to roll back to" "1" "$rc"

echo "refuses a bad argument before touching anything"
setup_box; install_stubs pass; make_tarball "$WORK/drop-dist.tar.gz"
run_deploy "$WORK/drop-dist.tar.gz" "not-a-sha" && rc=0 || rc=$?
check "exits 1 on a non-sha256 first argument" "1" "$rc"
check "the old build is untouched" "OLD BUILD" "$(cat /opt/drop/dist/marker)"
check "the service was never stopped" "no" \
  "$(grep -q 'systemctl stop' "$WORK/calls.log" && echo yes || echo no)"

run_deploy "/tmp/../etc/passwd" && rc=0 || rc=$?
check "exits 1 on a tarball path that is not a tarball" "1" "$rc"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
