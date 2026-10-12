#!/bin/zsh
# Wipe the public schema of the app's Nais Cloud SQL Postgres and restart the
# pods — the one-time cutover tool for when prod schema conflicts with a new
# migration baseline (used for the drizzle cutover, Oct 2026).
#
# Prereq: .env.secrets (repo root, gitignored) with the app DB user's creds
# from the Nais console (Application → reops-slack-bots → slackbots):
#   DB_URL=postgresql://reops-slack-bots@<host>/slackbots
#   DB_PASS=...
#
# Usage: scripts/wipe-db.sh
#
# Gotchas baked in (see ~/.config/opencode/skills/nais-postgres-admin):
# - proxy needs --reason and --team; speaks plain TCP locally (sslmode=disable)
# - IAM auth via `nais postgres grant` is flaky — use app-user password auth
# - parse .env.secrets raw: `source` chokes on unquoted & in URLs
# - email-style usernames break postgresql:// URIs — use psql kwargs
set -euo pipefail
cd "$(dirname "$0")/.."

DB_URL=$(sed -n 's/^DB_URL=//p' .env.secrets | head -1 | tr -d '"' | tr -d "'")
DB_PASS=$(sed -n 's/^DB_PASS=//p' .env.secrets | head -1 | tr -d '"' | tr -d "'")
: "${DB_URL:?missing in .env.secrets}"
: "${DB_PASS:?missing in .env.secrets}"

echo "==> starting nais postgres proxy on :5433…"
nais postgres proxy reops-slack-bots --team team-researchops --port 5433 \
  --reason "manual schema wipe (scripts/wipe-db.sh)" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT
for i in {1..40}; do
  nc -z localhost 5433 2>/dev/null && break
  sleep 1
done
nc -z localhost 5433 || { echo "ERROR: proxy never came up"; exit 1; }

URL_USER=$(print -r -- "$DB_URL" | sed -E 's#^postgres(ql)?://([^:@]+).*#\2#')
export PGPASSWORD="$DB_PASS"

echo "==> wiping public schema in slackbots DB…"
psql "host=localhost port=5433 user=$URL_USER dbname=slackbots sslmode=disable" <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "==> restarting app pods…"
kubectl -n team-researchops delete pod -l app=reops-slack-bots

echo
echo "==> done. Watch: kubectl -n team-researchops logs -f deploy/reops-slack-bots -c reops-slack-bots"
