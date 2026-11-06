#!/bin/sh
# Runs the attack corpus and golden programs against the real sandbox (isolate, cgroups v2), in
# each language's judge image. Needs Docker on Linux or a Linux VM (Docker Desktop, Colima).
#   services/sandbox-svc/test/attacks/run.sh [lang ...]     (default: all six)
# gVisor (layer 1) is exercised in the cluster; add --runtime=runsc where runsc is installed.
set -eu
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
LANGS="${*:-python java cpp c node go}"
ARCH="$(docker info --format '{{.Architecture}}' | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
RUNTIME="${ATTACK_RUNTIME:-}"

cd "$ROOT/services/sandbox-svc"
GOOS=linux GOARCH="$ARCH" CGO_ENABLED=0 go test -c -tags attack -o "$ROOT/services/sandbox-svc/test/attacks/attacks.test" ./test/attacks
cd "$ROOT"
built=$(sh infra/sandbox-images/build.sh atlas/judge)
status=0
for lang in $LANGS; do
  echo "== $lang"
  # --privileged + --cgroupns=host: isolate needs to create namespaces and a cgroup subtree.
  docker run --rm --privileged --cgroupns=host ${RUNTIME:+--runtime=$RUNTIME} \
    -e ATTACK_LANG="$lang" -v "$ROOT:/repo:ro" -w /repo/services/sandbox-svc/test/attacks \
    "atlas/judge-$lang:build" test /repo/services/sandbox-svc/test/attacks/attacks.test -test.v -test.timeout 15m \
    || status=1
done
rm -f "$ROOT/services/sandbox-svc/test/attacks/attacks.test"
echo "$built" > /dev/null
exit $status
