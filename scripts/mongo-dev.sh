#!/usr/bin/env bash
# Starts a single-node replica set for development on port 27018 (transactions need a replica set).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/.data/mongo"
mkdir -p "$DIR"
if ! mongosh --quiet --port 27018 --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1; then
  # --fork is unsupported on macOS; run detached with nohup instead.
  nohup mongod --replSet rs0 --port 27018 --dbpath "$DIR" --bind_ip 127.0.0.1 --logpath "$DIR/mongod.log" >/dev/null 2>&1 &
  for i in $(seq 1 30); do mongosh --quiet --port 27018 --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
fi
mongosh --quiet --port 27018 --eval 'try { rs.status().ok } catch (e) { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]}).ok }'
echo "Mongo replica set ready: mongodb://127.0.0.1:27018/?replicaSet=rs0"
