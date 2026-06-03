#!/usr/bin/env bash
# One-shot metrics writer — same logic as write_metrics() in backup-scheduler.sh,
# runnable by hand inside the container for debugging.
set -euo pipefail

STANZA="${PGBACKREST_STANZA:-todo-api}"
METRICS_FILE="${PGBACKREST_METRICS_FILE:-/tmp/pgbackrest-metrics.prom}"
FULL_ALERT_THRESHOLD="${PGBACKREST_FULL_ALERT_THRESHOLD:-$((30 * 3600))}"
DIFF_ALERT_THRESHOLD="${PGBACKREST_DIFF_ALERT_THRESHOLD:-$((7 * 3600))}"

info_json() { pgbackrest --stanza="$STANZA" info --output=json 2>/dev/null || echo '[]'; }
last_stop() {  # $1 = full|diff — newest stop epoch of that backup type, or 0
  info_json | jq -r --arg t "$1" \
    '[.[].backup[]? | select(.type==$t)] | sort_by(.timestamp.stop) | last | .timestamp.stop // 0' \
    2>/dev/null || echo 0
}

now=$(date -u +%s)
full_age=0 diff_age=0 count=0 wal_ok=0
lf=$(last_stop full); ld=$(last_stop diff)
[[ "${lf:-0}" -gt 0 ]] && full_age=$(( now - lf ))
[[ "${ld:-0}" -gt 0 ]] && diff_age=$(( now - ld ))
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

echo "Metrics written to ${METRICS_FILE}"
