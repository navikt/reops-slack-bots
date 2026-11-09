#!/usr/bin/env bash
# Needs NODE_AUTH_TOKEN (GitHub Packages read token) in the environment.
set -uo pipefail
IMAGE="reops-slack-bots"
PORT=9092
HOST_PORT=3092

echo "== docker build =="
docker build --pull --target runner \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN \
  -t "$IMAGE" . || echo "BUILD FAILED"

echo "== runtime node version =="
docker run --rm --entrypoint node "$IMAGE" --version || true

echo "== docker run =="
docker rm -f "$IMAGE" >/dev/null 2>&1 || true
docker run -d -p "$HOST_PORT:$PORT" --name "$IMAGE" "$IMAGE" || true
sleep 5

echo "== curl =="
curl -sI "localhost:$HOST_PORT/api/internal/isalive" || true

echo "== container logs =="
docker logs "$IMAGE" || true
docker rm -f "$IMAGE" >/dev/null 2>&1 || true

echo "== grype scan =="
grype "$IMAGE" -o table
