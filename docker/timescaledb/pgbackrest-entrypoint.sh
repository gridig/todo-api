#!/usr/bin/env bash
set -euo pipefail

# Railway injects PGHOST/PGPORT pointing at the remote service address; clear them
# so Postgres' own startup client tools and pgBackRest use the local socket.
unset PGHOST PGPORT

CONF="/etc/pgbackrest/pgbackrest.conf"
STANZA="${PGBACKREST_STANZA:-todo-api}"
REPO_TYPE="${PGBACKREST_REPO_TYPE:-s3}"
PG_PATH="${PGDATA:-/var/lib/postgresql/data}"

# Read the restore gate into locals, then unset the PGBACKREST_-prefixed vars. pgBackRest
# reads any PGBACKREST_* env var as a config option, so leaving PGBACKREST_RESTORE set makes
# every archive-get/backup log "WARN: environment contains invalid option 'restore'". Unsetting
# here (before any pgbackrest invocation) silences that while keeping the documented interface.
DO_RESTORE="${PGBACKREST_RESTORE:-0}"
RESTORE_ARGS="${PGBACKREST_RESTORE_ARGS:-}"
unset PGBACKREST_RESTORE PGBACKREST_RESTORE_ARGS

# An s3 repo with missing credentials FAILS CLOSED: nothing scrapes the backup
# metrics yet, so "Postgres up, archiving silently off" is an unbacked-up
# production database with zero signal — a visible refused boot is the only
# alert we actually have. PGBACKREST_ALLOW_UNCONFIGURED=true is the explicit,
# deliberate escape hatch (emergency boot / scratch environments), mirroring
# the app's *_PRODUCTION_CONFIRM flag pattern.
missing=""
if [[ "$REPO_TYPE" == "s3" ]]; then
  for v in PGBACKREST_REPO_S3_ENDPOINT PGBACKREST_REPO_S3_BUCKET \
           PGBACKREST_REPO_S3_KEY PGBACKREST_REPO_S3_KEY_SECRET PGBACKREST_CIPHER_PASS; do
    [[ -n "${!v:-}" ]] || missing="${missing} ${v}"
  done
fi

if [[ -n "$missing" ]]; then
  if [[ "${PGBACKREST_ALLOW_UNCONFIGURED:-}" == "true" ]]; then
    echo "WARNING: pgBackRest repo not configured (missing:${missing})." >&2
    echo "WARNING: PGBACKREST_ALLOW_UNCONFIGURED=true — starting Postgres WITHOUT archiving/backups." >&2
    exec docker-entrypoint.sh postgres
  fi
  echo "ERROR: pgBackRest repo not configured (missing:${missing})." >&2
  echo "ERROR: refusing to start an unbacked-up database. Set the vars and redeploy," >&2
  echo "ERROR: or set PGBACKREST_ALLOW_UNCONFIGURED=true to boot without backups deliberately." >&2
  exit 1
fi

mkdir -p /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"

# The config carries S3 credentials and the repo cipher passphrase — it must
# never be world-readable (default umask would leave it 0644 for any shell in
# the container). Create it 0600 BEFORE a single secret is written; the `>`
# redirect below truncates in place and keeps the mode.
install -m 600 /dev/null "$CONF"

{
  echo "[global]"
  if [[ "$REPO_TYPE" == "s3" ]]; then
    echo "repo1-type=s3"
    echo "repo1-s3-endpoint=${PGBACKREST_REPO_S3_ENDPOINT}"
    echo "repo1-s3-bucket=${PGBACKREST_REPO_S3_BUCKET}"
    echo "repo1-s3-region=${PGBACKREST_REPO_S3_REGION:-auto}"
    echo "repo1-s3-key=${PGBACKREST_REPO_S3_KEY}"
    echo "repo1-s3-key-secret=${PGBACKREST_REPO_S3_KEY_SECRET}"
    echo "repo1-cipher-type=aes-256-cbc"
    echo "repo1-cipher-pass=${PGBACKREST_CIPHER_PASS}"
  else
    echo "repo1-type=posix"
    echo "repo1-path=${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"
  fi
  echo "repo1-retention-full=${PGBACKREST_RETENTION_FULL:-35}"
  echo "repo1-retention-diff=${PGBACKREST_RETENTION_DIFF:-14}"
  echo "repo1-retention-archive=${PGBACKREST_RETENTION_ARCHIVE:-35}"
  echo "repo1-retention-archive-type=full"
  echo "start-fast=y"
  echo "process-max=${PGBACKREST_PROCESS_MAX:-2}"
  echo "log-level-console=info"
  echo "log-level-file=detail"
  echo "log-path=/var/log/pgbackrest"
  echo ""
  echo "[${STANZA}]"
  echo "pg1-path=${PG_PATH}"
  echo "pg1-port=${PG_PORT:-5432}"
  echo "pg1-socket-path=${PG_SOCKET_PATH:-/var/run/postgresql}"
  # Connect as the cluster superuser, not the invoking OS user — so ops commands
  # run via `docker compose exec` / `railway ssh` (as root) don't try a DB role
  # named "root". (The scheduler already runs as postgres via su-exec.)
  echo "pg1-user=${PGBACKREST_PG1_USER:-${POSTGRES_USER:-postgres}}"
} > "$CONF"

# archive_command runs as the postgres OS user and must be able to read the config.
chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"
chmod 600 "$CONF"

# Restore mode: populate an (empty/--delta) PGDATA from the repo BEFORE Postgres starts.
# The stock entrypoint then sees populated data, skips initdb, starts Postgres, and
# Postgres replays WAL to the target using the recovery settings pgBackRest wrote.
if [[ "$DO_RESTORE" == "1" ]]; then
  echo "=== RESTORE MODE: restoring '${STANZA}' into ${PG_PATH} ==="
  # shellcheck disable=SC2086
  su-exec postgres pgbackrest --stanza="${STANZA}" ${RESTORE_ARGS} restore
  echo "Restore staged. Postgres will start and replay WAL."
fi

# Background scheduler (as postgres), supervised: if it dies, backups silently
# stop, so relaunch with a logged restart instead of leaving a dead scheduler.
# The pgbackrest_last_*_age_seconds gauges remain the alerting backstop.
su-exec postgres bash -c '
  while true; do
    /usr/local/bin/backup-scheduler.sh
    echo "backup-scheduler exited rc=$? — restarting in 60s" >&2
    sleep 60
  done
' &

# Hand off to the stock entrypoint with archiving on. shared_preload_libraries=timescaledb
# stays set in postgresql.conf from initdb; we only append archiving flags here.
exec docker-entrypoint.sh postgres \
  -c archive_mode=on \
  -c "archive_command=pgbackrest --stanza=${STANZA} archive-push %p" \
  -c archive_timeout=60 \
  -c wal_level=replica \
  -c wal_keep_size=256MB \
  -c max_wal_senders=3
