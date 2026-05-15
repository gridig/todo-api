#!/usr/bin/env bash
set -euo pipefail

cleanup() { docker compose down 2>/dev/null; }
trap cleanup EXIT

if command -v gdate &>/dev/null; then
  now_ms() { echo $(( $(gdate +%s%N) / 1000000 )); }
elif date +%s%N 2>/dev/null | grep -q N; then
  now_ms() { python3 -c "import time; print(int(time.time()*1000))"; }
else
  now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
fi

PORT="${PORT:-3001}"

echo "Building container..."
docker compose build app

echo "Starting PostgreSQL..."
docker compose up -d postgres

echo "Waiting for PostgreSQL to be ready..."
until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 0.5
done

echo "Measuring container startup time..."
START=$(now_ms)
docker compose up -d app

until curl -sf "http://localhost:${PORT}/health/ready" > /dev/null 2>&1; do
  sleep 0.1
done

END=$(now_ms)
ELAPSED=$(( END - START ))

echo "Container startup to first healthy response: ${ELAPSED}ms"
