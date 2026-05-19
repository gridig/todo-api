#!/usr/bin/env bash
set -uo pipefail

# Auto-load .env into the bench shell if present. The server's dotenv loader
# already does this for its own process; mirror it here so a developer who
# just ran `pnpm bench:all` doesn't have to also `source .env` to make
# METRICS_TOKEN visible to the curl in capture_server_metrics(). Inline env
# vars on the command line take precedence (set -a only injects missing keys
# when `source` reads variables already exported in the parent shell).
if [[ -z "${METRICS_TOKEN:-}" && -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${METRICS_TOKEN:-}" ]]; then
  echo "Warning: METRICS_TOKEN is not set — /metrics scraping will fail (401)." >&2
  echo "         Pass it inline (METRICS_TOKEN=... pnpm bench:all) or add it to .env." >&2
fi

BASE_URL="${BASE_URL:-http://localhost:3001}"
COOLDOWN="${COOLDOWN:-10}"
RESULTS_DIR="benchmarks/results"
EXIT_CODE=0
mkdir -p "$RESULTS_DIR"

echo "=== Todo API Benchmark Suite ==="
echo "Target: $BASE_URL"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

echo "--- Environment ---"
echo "Node.js: $(node --version)"
echo "k6: $(k6 version)"
echo "OS: $(uname -srm)"
echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu 2>/dev/null | grep 'Model name' | sed 's/.*: //')"
echo "CPU cores: $(nproc 2>/dev/null || sysctl -n hw.ncpu)"
echo "RAM: $(sysctl -n hw.memsize 2>/dev/null | awk '{print $0/1073741824 " GB"}' || free -h 2>/dev/null | awk '/Mem:/{print $2}')"
echo "Express: $(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).dependencies.express")"
echo "Prisma: $(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).dependencies['@prisma/client']")"
echo "PostgreSQL: $(psql --version 2>/dev/null || docker exec todo-postgres psql --version 2>/dev/null || echo 'N/A')"
echo "Docker: $(docker --version 2>/dev/null || echo 'N/A')"
echo ""

capture_server_metrics() {
  local label="$1"
  local file="$RESULTS_DIR/${label}-server-metrics.txt"
  if [[ -n "${METRICS_TOKEN:-}" ]]; then
    curl -sf -H "Authorization: Bearer $METRICS_TOKEN" "$BASE_URL/metrics" > "$file" 2>/dev/null \
      || echo "Warning: Could not capture server metrics" >&2
  else
    curl -sf "$BASE_URL/metrics" > "$file" 2>/dev/null \
      || echo "Warning: Could not capture server metrics" >&2
  fi
}

run_bench() {
  local label="$1"; shift
  echo ">>> $label"
  if ! k6 run "$@"; then
    echo "WARNING: $label failed thresholds" >&2
    EXIT_CODE=1
  fi
}

for level in low medium high overload; do
  run_bench "Framework overhead - $level" \
    --env BASE_URL="$BASE_URL" --env LOAD_LEVEL="$level" \
    benchmarks/k6/framework-overhead.js
  capture_server_metrics "framework-overhead-$level"
  echo "Cooling down for ${COOLDOWN}s..."
  sleep "$COOLDOWN"
  echo ""
done

for level in low medium high overload; do
  run_bench "Application performance - $level" \
    --env BASE_URL="$BASE_URL" --env LOAD_LEVEL="$level" \
    benchmarks/k6/application-performance.js
  capture_server_metrics "application-performance-$level"
  if [ "$level" != "overload" ]; then
    echo "Cooling down for ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
  echo ""
done

echo "=== All benchmarks complete. Results in $RESULTS_DIR ==="
exit $EXIT_CODE
