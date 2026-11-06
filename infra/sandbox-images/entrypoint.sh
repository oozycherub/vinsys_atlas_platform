#!/bin/sh
# Starts isolate's cgroup keeper (cgroups v2 delegation without systemd), then the worker.
# The worker exits on SIGTERM after finishing its current jobs' leases expire or complete.
set -eu
if [ ! -d /sys/fs/cgroup/isolate.slice ]; then
  mkdir -p /sys/fs/cgroup/isolate.slice
fi
/usr/local/sbin/isolate-cg-keeper --move-cg-neighbors &
keeper=$!
trap 'kill "$keeper" 2>/dev/null || true' EXIT
# The keeper creates the subtree asynchronously.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -f /sys/fs/cgroup/isolate.slice/cgroup.subtree_control ] && break
  sleep 0.2
done
if [ "${1:-}" = "test" ]; then
  shift
  exec "$@"
fi
exec /usr/local/bin/judge-worker "$@"
