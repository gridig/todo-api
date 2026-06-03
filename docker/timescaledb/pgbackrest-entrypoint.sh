#!/usr/bin/env bash
set -euo pipefail

CONF="/etc/pgbackrest/pgbackrest.conf"
STANZA="${PGBACKREST_STANZA:-todo-api}"
REPO_TYPE="${PGBACKREST_REPO_TYPE:-s3}"
PG_PATH="${PGDATA:-/var/lib/postgresql/data}"

mkdir -p /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"

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
} > "$CONF"

# archive_command runs as the postgres OS user and must be able to read the config.
chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"

# Restore mode: populate an (empty/--delta) PGDATA from the repo BEFORE Postgres starts.
# The stock entrypoint then sees populated data, skips initdb, starts Postgres, and
# Postgres replays WAL to the target using the recovery settings pgBackRest wrote.
if [[ "${PGBACKREST_RESTORE:-0}" == "1" ]]; then
  echo "=== RESTORE MODE: restoring '${STANZA}' into ${PG_PATH} ==="
  # shellcheck disable=SC2086
  su-exec postgres pgbackrest --stanza="${STANZA}" ${PGBACKREST_RESTORE_ARGS:-} restore
  echo "Restore staged. Postgres will start and replay WAL."
fi

# Background scheduler (as postgres). It waits for Postgres, creates the stanza, loops.
su-exec postgres /usr/local/bin/backup-scheduler.sh &

# Hand off to the stock entrypoint with archiving on. shared_preload_libraries=timescaledb
# stays set in postgresql.conf from initdb; we only append archiving flags here.
exec docker-entrypoint.sh postgres \
  -c archive_mode=on \
  -c "archive_command=pgbackrest --stanza=${STANZA} archive-push %p" \
  -c archive_timeout=60 \
  -c wal_level=replica \
  -c wal_keep_size=256MB \
  -c max_wal_senders=3
