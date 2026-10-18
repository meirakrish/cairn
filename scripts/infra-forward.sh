#!/usr/bin/env bash
# Forwards the minikube services to localhost for `pnpm dev`. Restarts a forward if it drops
# (e.g. after a pod restart). Ctrl-C stops all of them.
set -uo pipefail

ctx=${KUBE_CONTEXT:-cairn}
ns=cairn

forward() {
  while true; do
    kubectl --context "$ctx" -n "$ns" port-forward "svc/$1" "$2" >/dev/null
    echo "port-forward $1 dropped, retrying in 2s" >&2
    sleep 2
  done
}

trap 'kill 0' INT TERM EXIT
forward postgres 5432:5432 &
forward redis 6379:6379 &
forward garage 3900:3900 &
echo "forwarding postgres :5432, redis :6379, garage s3 :3900 (context $ctx)"
wait
