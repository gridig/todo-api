#!/usr/bin/env bash
set -euo pipefail

STANZA="${PGBACKREST_STANZA:-todo-api}"
METRICS_FILE="${PGBACKREST_METRICS_FILE:-/tmp/pgbackrest-metrics.prom}"
DIFF_INTERVAL="${PGBACKREST_DIFF_INTERVAL_SEC:-$((6 * 3600))}"
LOOP_SLEEP="${PGBACKREST_LOOP_SLEEP_SEC:-60}"
FULL_MAX_AGE="${PGBACKREST_FULL_MAX_AGE_SEC:-$((26 * 3600))}"   # hard catch-up ceiling (< 30h full-age alert)
FULL_ALERT_THRESHOLD="${PGBACKREST_FULL_ALERT_THRESHOLD:-$((30 * 3600))}"
DIFF_ALERT_THRESHOLD="${PGBACKREST_DIFF_ALERT_THRESHOLD:-$((7 * 3600))}"
printf -v FULL_HOUR '%02d' "${PGBACKREST_FULL_HOUR_UTC:-2}"   # daily full window (02:00 UTC)

info_json() { pgbackrest --stanza="$STANZA" info --output=json 2>/dev/null || echo '[]'; }
last_stop() {  # $1 = full|diff — newest stop epoch of that backup type, or 0
  info_json | jq -r --arg t "$1" \
    '[.[].backup[]? | select(.type==$t)] | sort_by(.timestamp.stop) | last | .timestamp.stop // 0' \
    2>/dev/null || echo 0
}

until pg_isready -q; do sleep 2; done
pgbackrest --stanza="$STANZA" stanza-create 2>&1 || echo "WARN: stanza-create non-zero (may already exist)"

# Seed from the repo so restarts don't double-back-up (fixes the cold-start bug).
last_full=$(last_stop full); last_full=${last_full:-0}
last_diff=$(last_stop diff); last_diff=${last_diff:-0}

write_metrics() {
  local now full_age=0 diff_age=0 count=0 wal_ok=0 lf ld
  now=$(date -u +%s)
  lf=$(last_stop full); ld=$(last_stop diff)
  [[ "${lf:-0}" -gt 0 ]] && full_age=$(( now - lf )) && last_full=$lf
  [[ "${ld:-0}" -gt 0 ]] && diff_age=$(( now - ld )) && last_diff=$ld
  count=$(info_json | jq '[.[].backup[]?] | length' 2>/dev/null || echo 0)
  pgbackrest --stanza="$STANZA" check >/dev/null 2>&1 && wal_ok=1
  cat > "$METRICS_FILE" <<EOF
# HELP pgbackrest_last_full_backup_age_seconds Seconds since last successful full backup
# TYPE pgbackrest_last_full_backup_age_seconds gauge
pgbackrest_last_full_backup_age_seconds ${full_age}
# HELP pgbackrest_last_diff_backup_age_seconds Seconds since last successful differential backup
# TYPE pgbackrest_last_diff_backup_age_seconds gauge
pgbackrest_last_diff_backup_age_seconds ${diff_age}
# HELP pgbackrest_wal_archive_ok Whether WAL archiving is working (1=ok, 0=failing)
# TYPE pgbackrest_wal_archive_ok gauge
pgbackrest_wal_archive_ok ${wal_ok}
# HELP pgbackrest_total_backups Total number of backups in the repository
# TYPE pgbackrest_total_backups gauge
pgbackrest_total_backups ${count}
# HELP pgbackrest_full_alert_threshold_seconds Alert threshold for full backup age
# TYPE pgbackrest_full_alert_threshold_seconds gauge
pgbackrest_full_alert_threshold_seconds ${FULL_ALERT_THRESHOLD}
# HELP pgbackrest_diff_alert_threshold_seconds Alert threshold for diff backup age
# TYPE pgbackrest_diff_alert_threshold_seconds gauge
pgbackrest_diff_alert_threshold_seconds ${DIFF_ALERT_THRESHOLD}
EOF
}

echo "Scheduler started. Full window=${FULL_HOUR}:00 UTC, Diff=${DIFF_INTERVAL}s"

while true; do
  now=$(date -u +%s)
  hour=$(date -u +%H)

  # First-ever full immediately; otherwise once per UTC day in the low-traffic
  # window (epoch-day compare avoids same-day double-fire on restart), with a hard
  # age ceiling so a missed window catches up the same day and re-syncs to 02:00.
  if (( last_full == 0 )) \
     || { [[ "$hour" == "$FULL_HOUR" ]] && (( last_full / 86400 != now / 86400 )); } \
     || (( now - last_full >= FULL_MAX_AGE )); then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Starting full backup..."
    if pgbackrest --stanza="$STANZA" --type=full backup 2>&1; then
      last_full=$(date -u +%s)
      pgbackrest --stanza="$STANZA" verify 2>&1 || echo "WARN: post-backup verify failed!" >&2
    else
      echo "ERROR: Full backup FAILED!" >&2
    fi
  fi

  # Differential every 6h, skipped right after a full.
  if (( now - last_diff >= DIFF_INTERVAL )) && (( now - last_full > 300 )); then
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Starting differential backup..."
    if pgbackrest --stanza="$STANZA" --type=diff backup 2>&1; then
      last_diff=$(date -u +%s)
    else
      echo "ERROR: Differential backup FAILED!" >&2
    fi
  fi

  write_metrics
  sleep "$LOOP_SLEEP"
done
