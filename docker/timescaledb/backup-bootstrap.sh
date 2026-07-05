#!/usr/bin/env bash
# One-time stanza creation + first full backup. Idempotent. Runs inside the
# timescaledb service container (where the binary, config, and socket live):
#   railway exec --service timescaledb -- backup-bootstrap.sh
# The scheduler also self-bootstraps a first full on an empty stanza; this script
# is for explicit, verified control.
set -euo pipefail

# pgBackRest must run as the cluster owner (postgres), not root: it connects to
# Postgres as the invoking OS user, and a full backup writes repo files that the
# postgres-owned scheduler must later manage. Re-exec under postgres when started
# as root (the docker/railway exec default).
if [ "$(id -u)" -eq 0 ]; then exec su-exec postgres "$0" "$@"; fi

STANZA="${PGBACKREST_STANZA:-todo-api}"

echo "=== pgBackRest Bootstrap (stanza: ${STANZA}) ==="

echo "1. Postgres connectivity..."
pgbackrest --stanza="$STANZA" check 2>&1 || { echo "ERROR: cannot reach Postgres / archiving not ready." >&2; exit 1; }

echo "2. Creating stanza (idempotent)..."
pgbackrest --stanza="$STANZA" stanza-create 2>&1 || echo "WARN: stanza-create non-zero (may already exist)."

echo "3. First full backup..."
pgbackrest --stanza="$STANZA" --type=full backup 2>&1 || { echo "ERROR: first full backup failed!" >&2; exit 1; }

echo "4. Verify..."
pgbackrest --stanza="$STANZA" verify 2>&1 || { echo "ERROR: verification failed!" >&2; exit 1; }

echo "=== Done ==="
pgbackrest --stanza="$STANZA" info 2>&1 || true
