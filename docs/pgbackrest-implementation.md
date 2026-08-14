# pgBackRest Implementation Guide

Step-by-step instructions for implementing the pgBackRest backup architecture from `docs/databases.md` (§Backup & DR with pgBackRest → Railway Buckets), using the **co-located model**: pgBackRest runs _inside_ the TimescaleDB service container, not as a separate sidecar.

**Prerequisite**: Step 1 (Railway Bucket provisioning) is complete. You have a Railway Bucket with its S3-compatible endpoint URL, access key ID, and secret.

**No changes to `src/`** — the Express app is untouched. All changes are infrastructure (Docker, Railway config, scripts, docs).

---

## Why co-located, not a sidecar

The earlier sidecar design (a standalone pgbackrest service mounting the DB's data volume) cannot run on Railway, and is broken even locally, for two structural reasons:

1. **Railway gives one volume per service and does not share volumes across services.** A sidecar cannot read the DB's `PGDATA` to take a backup, and cannot write into it to restore.
2. **`archive_command` runs _inside_ the Postgres process.** pgBackRest invoked there needs its own `pgbackrest.conf` (S3 endpoint, keys, cipher pass, `pg1-path`) and repo access _in the Postgres container_. A sidecar that holds the only config means every WAL push fails.

`backup`, `archive-push`, and `restore` all need local `PGDATA` + a live Postgres connection + the same repo config. Putting pgBackRest in the same container as Postgres satisfies all three at once, needs no shared volume (the repo is S3), and removes the cross-host version-compatibility problem entirely (there is exactly one pgBackRest install).

```
┌──────────────── Railway project ────────────────┐
│                                                  │
│   ┌─────────────┐   ┌───────────────────────┐   │
│   │  todo-api   │──▶│  timescaledb service   │   │
│   │  (Node app) │   │  ┌──────────────────┐  │   │
│   └─────────────┘   │  │ Postgres 16 + ext│  │   │
│                     │  │ pgBackRest binary│  │   │
│                     │  │ backup scheduler │  │   │
│                     │  └────────┬─────────┘  │   │
│                     └───────────┼────────────┘   │
└─────────────────────────────────┼────────────────┘
                                  ▼  WAL + base backups (S3 API)
                        ┌──────────────────┐
                        │ Railway Bucket   │  encrypted (AES-256), versioned
                        └──────────────────┘
```

---

## File Tree

```
todo-api/
├── docker/
│   └── timescaledb/
│       ├── Dockerfile                  # TimescaleDB + pgBackRest + scheduler
│       ├── pgbackrest-entrypoint.sh    # writes conf, restore mode, starts scheduler, hands off to Postgres
│       ├── backup-scheduler.sh         # stanza-create + scheduled full/diff + metrics
│       ├── metrics-exporter.sh         # one-shot metrics writer (debugging)
│       └── backup-bootstrap.sh         # NEW: one-time stanza + first backup (COPYed into the image)
├── docker-compose.yml                  # MODIFIED: postgres builds the new image; posix repo volume
└── docs/
    ├── operations.md                   # MODIFIED: add restore runbook
    ├── databases.md                    # MODIFIED: topology (co-located), retention, RPO
    ├── configuration.md                # MODIFIED: add env vars
    └── docker.md                       # MODIFIED: document the image
```

There is **no** `docker/pgbackrest/` directory — pgBackRest ships inside the TimescaleDB image.

---

## Step 2: TimescaleDB + pgBackRest Image

### 2.1 `docker/timescaledb/Dockerfile`

```dockerfile
# Pin the base tag for reproducibility (replace with the current pg16 tag you deploy).
# pgBackRest is installed once, here, and is the only pgBackRest in the system — so
# archive-push / backup / restore can never drift across versions.
FROM timescale/timescaledb:2.17.2-pg16

USER root

# pgbackrest + jq live in Alpine's community repo; add the matching-version community
# line (avoids mixing edge with the base image's Alpine release). su-exec/bash ship
# with the postgres-alpine base but are listed for clarity.
RUN set -eux; \
    echo "https://dl-cdn.alpinelinux.org/alpine/v$(cut -d. -f1,2 /etc/alpine-release)/community" >> /etc/apk/repositories; \
    apk add --no-cache pgbackrest jq bash su-exec

COPY pgbackrest-entrypoint.sh /usr/local/bin/pgbackrest-entrypoint.sh
COPY backup-scheduler.sh      /usr/local/bin/backup-scheduler.sh
COPY metrics-exporter.sh      /usr/local/bin/metrics-exporter.sh
RUN chmod +x /usr/local/bin/pgbackrest-entrypoint.sh \
             /usr/local/bin/backup-scheduler.sh \
             /usr/local/bin/metrics-exporter.sh

ENTRYPOINT ["/usr/local/bin/pgbackrest-entrypoint.sh"]
```

> `timescale/timescaledb:*-pg16` is the **Alpine** image (`apk`, not `apt-get`). The Ubuntu-based `timescale/timescaledb-ha` would also work but is much larger and ships Patroni — unnecessary here.

### 2.2 `docker/timescaledb/pgbackrest-entrypoint.sh`

Writes the config from env vars (S3 in prod, POSIX locally), optionally restores before Postgres starts, launches the scheduler in the background as `postgres`, then hands off to the stock TimescaleDB entrypoint with WAL archiving enabled.

Two hardening behaviors (the snippet below is abridged — the shipped script is authoritative):

- **Missing S3 config fails closed.** If `PGBACKREST_REPO_TYPE=s3` and any of the endpoint/bucket/key/secret/cipher-pass vars are unset, the container **refuses to start** rather than silently running an unbacked-up database (nothing scrapes the backup metrics yet, so a visible refused boot is the only real alert). Set `PGBACKREST_ALLOW_UNCONFIGURED=true` to deliberately boot without backups (emergency / scratch environments only).
- **The config file is `0600`.** It carries the S3 credentials and the repo cipher passphrase; it is created with `install -m 600` before any secret is written and `chmod 600` re-asserted after the `chown` to `postgres`.

```bash
#!/usr/bin/env bash
set -euo pipefail

CONF="/etc/pgbackrest/pgbackrest.conf"
STANZA="${PGBACKREST_STANZA:-todo-api}"
REPO_TYPE="${PGBACKREST_REPO_TYPE:-s3}"
PG_PATH="${PGDATA:-/var/lib/postgresql/data}"

mkdir -p /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"

# Secrets land in this file — create it 0600 before writing a single one.
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
  # run via docker/`railway ssh` (as root) don't try a DB role named "root".
  echo "pg1-user=${PGBACKREST_PG1_USER:-${POSTGRES_USER:-postgres}}"
} > "$CONF"

# archive_command runs as the postgres OS user and must be able to read the config.
chown -R postgres:postgres /etc/pgbackrest /var/log/pgbackrest "${PGBACKREST_REPO_PATH:-/var/lib/pgbackrest}"
chmod 600 "$CONF"

# Restore mode: populate an (empty/--delta) PGDATA from the repo BEFORE Postgres starts.
# The stock entrypoint then sees populated data, skips initdb, starts Postgres, and
# Postgres replays WAL to the target using the recovery settings pgBackRest wrote.
# DO_RESTORE/RESTORE_ARGS are read from PGBACKREST_RESTORE[_ARGS] and unset earlier in the
# entrypoint — pgBackRest reads any PGBACKREST_* var as a config option, so leaving them set
# makes every archive-get log "WARN: environment contains invalid option 'restore'".
if [[ "$DO_RESTORE" == "1" ]]; then
  echo "=== RESTORE MODE: restoring '${STANZA}' into ${PG_PATH} ==="
  # shellcheck disable=SC2086
  su-exec postgres pgbackrest --stanza="${STANZA}" ${RESTORE_ARGS} restore
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
```

**Notes / known limits:**

- The scheduler is a background child of the postgres entrypoint (PID 1). If it dies, backups stop — surfaced by stale `pgbackrest_*_age_seconds` metrics and the WAL-ok gauge. A process supervisor (s6) is the upgrade path if that proves fragile.
- During first-boot init, the stock entrypoint briefly runs a temporary server (archiving off) to apply `/docker-entrypoint-initdb.d`. The scheduler tolerates this: `stanza-create` is idempotent and the real gate is `pgbackrest check`, which only passes once the final server with archiving is up.

### 2.3 `docker/timescaledb/backup-scheduler.sh`

Waits for Postgres, creates the stanza, **seeds the last-backup timestamps from the repo** (so a container restart never triggers a spurious backup), then runs a daily full in the low-traffic window + a 6-hour differential, writing Prometheus metrics each loop.

```bash
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
```

### 2.4 `docker/timescaledb/metrics-exporter.sh`

A one-shot version of `write_metrics` for debugging — run it by hand inside the container to refresh `/tmp/pgbackrest-metrics.prom` on demand. Same `info --output=json | jq` logic as above; omitted here for brevity (copy `write_metrics` into a standalone script that runs once and exits).

---

## Step 3: WAL Archiving

With pgBackRest co-located, `archive_command` resolves correctly: it reads `/etc/pgbackrest/pgbackrest.conf` (written by the entrypoint, owned by `postgres`) and pushes WAL to the same repo the scheduler backs up to.

The archiving flags are passed by the entrypoint (Step 2.2). What they buy:

- `archive_timeout=60` forces a WAL switch every 60s even on a quiet DB — this is what bounds RPO to ~1 minute.
- `wal_keep_size=256MB` keeps WAL around long enough for archiving to consume it.
- `wal_level=replica` / `max_wal_senders=3` are archiving prerequisites (replica is already the TimescaleDB default; explicit for safety).

`shared_preload_libraries=timescaledb` is **not** passed on the command line — it is set in `postgresql.conf` at initdb by the base image, and appending `-c` flags does not remove it. Confirm after deploy with `SHOW shared_preload_libraries;`.

---

## Step 4: `docker-compose.yml` (local dev / CI)

One service. POSIX repo on a volume mounted to the same container — no S3 credentials needed locally.

```yaml
services:
  postgres:
    build:
      context: ./docker/timescaledb
      dockerfile: Dockerfile
    container_name: todo-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: todo_api
      PGBACKREST_STANZA: todo-api
      PGBACKREST_REPO_TYPE: posix
      PGBACKREST_REPO_PATH: /var/lib/pgbackrest
      PGBACKREST_RETENTION_FULL: '2'
      PGBACKREST_RETENTION_DIFF: '2'
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - pgbackrest_data:/var/lib/pgbackrest
      # initdb only runs on a fresh volume — `docker compose down -v` to re-bootstrap roles.
      - ./prisma/sql/bootstrap_roles.sql:/docker-entrypoint-initdb.d/01-bootstrap_roles.sql:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      timeout: 5s
      retries: 5

  # ... existing redis and app services unchanged ...

volumes:
  postgres_data:
  redis_data:
  pgbackrest_data:
```

The `pgbackrest` sidecar service from the old design is removed. For a fast local smoke test of the scheduler, the first full runs immediately on a new stanza (no need to wait for the 02:00 window).

---

## Step 5: Railway — TimescaleDB service

1. Point the **timescaledb** service to build from `docker/timescaledb/Dockerfile`.
2. Set the env vars from the table in **Step 9** (S3 endpoint/keys, cipher pass, retention). `PGBACKREST_REPO_TYPE` defaults to `s3`.
3. No second service, and no command override needed — the image's `ENTRYPOINT` writes config, starts the scheduler, and enables archiving. (The repo is S3, so Railway's one-volume-per-service limit is irrelevant.)

---

## Step 6: Bootstrap Script

`docker/timescaledb/backup-bootstrap.sh` — one-time stanza creation + first full backup. Idempotent. `COPY`ed into the image at `/usr/local/bin/backup-bootstrap.sh` (the timescaledb container has no repo checkout, so it must ship in the image). Run it once after the first deploy to guarantee a backup exists immediately (rather than waiting for the scheduler's window). The scheduler also self-bootstraps a first full on an empty stanza, so this is for explicit, verified control.

```bash
#!/usr/bin/env bash
set -euo pipefail

# pgBackRest must run as the cluster owner (postgres), not root: it connects as
# the invoking OS user and writes repo files the postgres-owned scheduler manages.
# Re-exec under postgres when started as root (the docker/`railway ssh` default).
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
```

> No `--force`. `--type=full` already forces a full backup; `--force` is only valid on `stanza-create`/`stanza-delete`/`restore` and would error on `backup`.

**Usage** (runs inside the DB service, where the binary, config, and socket live):

```bash
railway ssh --service timescaledb "backup-bootstrap.sh"
```

---

## Step 7: Restore Runbook

Add to `docs/operations.md`.

```markdown
## Database Restore (Disaster Recovery)

### Recovery Targets

| Metric | Target       | Bounded By                                     |
| ------ | ------------ | ---------------------------------------------- |
| RPO    | ≤ 5 minutes  | `archive_timeout = 60s` + WAL push latency     |
| RTO    | ≤ 30 minutes | Provision + restore + WAL replay + app repoint |

> pgBackRest takes **physical** backups of the whole cluster — `pg_authid` (roles + passwords),
> all databases, and the `REVOKE`-based audit immutability are included. A restore does **not**
> need role re-bootstrap (that is only for logical `pg_dump` restores). The `bootstrap_roles*.sql`
> init script does not run on a restored volume, and does not need to.

### Scenario A: Full Database Loss

1. **Stop writes** — stop the `todo-api` service so nothing writes during recovery.
2. **Provision a fresh timescaledb service** from `docker/timescaledb/Dockerfile` with an **empty**
   data volume and the same `PGBACKREST_*` env (same bucket, keys, cipher pass, stanza).
3. **Set restore env** on that service and deploy:
   - `PGBACKREST_RESTORE=1`
     The entrypoint restores into the empty `PGDATA` before Postgres starts; Postgres then replays
     WAL to the latest point and promotes.
4. **Verify** (inside the service):
   - `psql -c '\du'` — `db_admin`, `db_app`, `db_auditor` present
   - `psql -c '\dt'` — `users`, `todos`, `audit_entries`, `_prisma_migrations` present
   - Immutability probe: `SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;`
     → must fail with `42501` (permission denied)
5. **Clear restore env** — set `PGBACKREST_RESTORE=0` (or remove it) and redeploy so the service
   does not re-restore on its next restart.
6. **Repoint the app** — point `DATABASE_URL` / `DATABASE_MIGRATE_URL` at the restored service and
   redeploy `todo-api`. Confirm startup logs:
   `preflight-roles: OK` · `Audit-log tamper-evidence probe passed` · `Server started successfully` · `/health/ready → 200`.

### Scenario B: Point-in-Time Recovery (bad migration / data corruption)

Same as Scenario A, but in step 3 also set:

- `PGBACKREST_RESTORE_ARGS=--type=time --target="2026-06-01 12:00:00+00"`
  Add `--target-exclusive` to stop _before_ the bad event. Use `--delta` instead of an empty volume
  to restore in place over existing data.

### Quarterly Restore Drill (SOC 2 A1.3)

1. Provision a **throwaway** timescaledb service, restore the latest backup (Scenario A, steps 2–4).
2. Point a scratch `todo-api` at it; run `pnpm test:integration`.
3. Document: date, backup ID (`pgbackrest info`), wall-clock restore time, pass/fail counts.
4. Tear down. File the report as SOC 2 A1.3 evidence.
```

---

## Step 8: Monitoring & Alerting

The scheduler writes `/tmp/pgbackrest-metrics.prom` every loop. There is **no** HTTP listener for it yet — do not expose a port that nothing serves.

**Now:** there is **no interim alert**. Railway has no native log-content alerting — its webhooks fire on _deploy_ state, and a backup failure does not change deploy state (the container keeps running), so a deploy webhook never sees it. The scheduler still logs `ERROR: Full backup FAILED!` / `ERROR: Differential backup FAILED!`, but nothing is wired to notify on those lines. Backup-failure alerting is delivered by the Prometheus rules in the **Later** table below, tracked under the **Monitoring & Observability** roadmap item.

If pre-Prometheus alerting is ever needed before that lands, the two viable paths (neither implemented) are: a Railway **log drain** forwarding this service's logs to an external service (e.g. Better Stack) that alerts on the `ERROR:` pattern, or a webhook `POST` added to `backup-scheduler.sh`'s failure branch (gated on an alert-URL env var).

**Later (Monitoring & Observability roadmap item):** expose the metrics file via a node_exporter
`--collector.textfile.directory` mount or a tiny HTTP exporter, then add:

| Alert                                              | Condition                      | Severity |
| -------------------------------------------------- | ------------------------------ | -------- |
| `pgbackrest_last_full_backup_age_seconds > 108000` | No full in 30h                 | Critical |
| `pgbackrest_last_diff_backup_age_seconds > 25200`  | No diff in 7h                  | Warning  |
| `pgbackrest_wal_archive_ok == 0`                   | Archiving broken — RPO at risk | Critical |

---

## Step 9: Retention & Configuration

**Retention target.** Defaults give a **35-day continuous PITR window** (daily fulls; WAL retained for the oldest retained full): `retention-full=35`, `retention-diff=14`, `retention-archive=35`. This exceeds the `ROADMAP.md` floor (≥30-day retention).

> **Reconcile the 1-year claim.** `docs/databases.md` currently states "Retention: 1 year". A _backup_ PITR window of a full year means storing ~365 fulls' worth of WAL — disproportionate at this scale. The 1-year **compliance** requirement is satisfied by the in-DB audit retention (`add_retention_policy('audit_entries', INTERVAL '1 year')`, already shipped) plus, if a 1-year _recoverable copy_ is required, a periodic exported full to cold storage. Update `databases.md` to state the 35-day PITR window and the 1-year audit-data retention separately, instead of implying a 1-year backup window.

Also add an object-lifecycle rule on the Railway Bucket to expire objects past the retention horizon (e.g. 40 days) as a defense-in-depth safety net.

### Environment variables (on the **timescaledb** service) — for `docs/configuration.md`

| Variable                        | Default                        | Description                                                                                                                                   |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGBACKREST_REPO_TYPE`          | `s3`                           | `s3` (prod) or `posix` (local)                                                                                                                |
| `PGBACKREST_REPO_S3_ENDPOINT`   | _(required for s3)_            | Railway Bucket S3 endpoint URL                                                                                                                |
| `PGBACKREST_REPO_S3_BUCKET`     | _(required for s3)_            | Bucket name                                                                                                                                   |
| `PGBACKREST_REPO_S3_KEY`        | _(required for s3)_            | Access key ID                                                                                                                                 |
| `PGBACKREST_REPO_S3_KEY_SECRET` | _(required for s3)_            | Secret access key                                                                                                                             |
| `PGBACKREST_REPO_S3_REGION`     | `auto`                         | S3 region                                                                                                                                     |
| `PGBACKREST_REPO_PATH`          | `/var/lib/pgbackrest`          | POSIX repo path (local only)                                                                                                                  |
| `PGBACKREST_CIPHER_PASS`        | _(required)_                   | AES-256 passphrase (32+ chars)                                                                                                                |
| `PGBACKREST_STANZA`             | `todo-api`                     | Stanza name                                                                                                                                   |
| `PGBACKREST_PG1_USER`           | `$POSTGRES_USER` or `postgres` | DB role pgBackRest connects as (cluster superuser). Lets root-invoked ops commands work instead of trying a role named after the OS user      |
| `PGBACKREST_RETENTION_FULL`     | `35`                           | Daily full backups to retain (≈ PITR window in days)                                                                                          |
| `PGBACKREST_RETENTION_DIFF`     | `14`                           | Differentials to retain                                                                                                                       |
| `PGBACKREST_RETENTION_ARCHIVE`  | `35`                           | Fulls' worth of WAL to retain                                                                                                                 |
| `PGBACKREST_PROCESS_MAX`        | `2`                            | Parallel processes for backup/restore                                                                                                         |
| `PGBACKREST_FULL_HOUR_UTC`      | `2`                            | UTC hour for the daily full window                                                                                                            |
| `PGBACKREST_FULL_MAX_AGE_SEC`   | `93600`                        | Hard catch-up ceiling for the daily full (26h) — run a full regardless of window once the last is this old. Keep below the 30h full-age alert |
| `PGBACKREST_DIFF_INTERVAL_SEC`  | `21600`                        | Differential interval (seconds)                                                                                                               |
| `PGBACKREST_LOOP_SLEEP_SEC`     | `60`                           | Scheduler check interval (seconds)                                                                                                            |
| `PGBACKREST_RESTORE`            | `0`                            | `1` = restore into PGDATA before Postgres starts (DR only)                                                                                    |
| `PGBACKREST_RESTORE_ARGS`       | _(empty)_                      | Extra restore flags, e.g. `--type=time --target=...`, `--delta`                                                                               |

---

## Step 10: CI

Validate the single image builds (config validation happens at `stanza-create` runtime, not build time):

```yaml
- name: Validate TimescaleDB + pgBackRest image
  run: docker build -t timescaledb-test -f docker/timescaledb/Dockerfile docker/timescaledb/
```

---

## Step 11: Documentation Updates

| File                    | What to change                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/operations.md`    | Add the restore runbook (Step 7)                                                                                                                                                              |
| `docs/databases.md`     | Topology diagram → pgBackRest **co-located** in the timescaledb container (not a sidecar); retention → 35-day PITR window; separate the 1-year **audit-data** retention from backup retention |
| `docs/configuration.md` | Add the env-var table (Step 9) under the timescaledb service                                                                                                                                  |
| `docs/docker.md`        | Document the `docker/timescaledb/` image (Postgres + pgBackRest + scheduler)                                                                                                                  |
| `ROADMAP.md`            | Check off the Backup & DR subtasks; reword the `pg_dump`-to-object-storage bullet to reflect the chosen tool (pgBackRest + WAL/PITR), so the SOC 2 change-management artifact matches reality |

---

## Step 12: Deploy & Verify

### Order

1. Deploy the new **timescaledb** image with `PGBACKREST_*` env set.
2. Run the bootstrap: `railway ssh --service timescaledb "backup-bootstrap.sh"`.
3. Confirm archiving: `railway ssh --service timescaledb "pgbackrest --stanza=todo-api check"`.

### Pre-deploy checklist

- [ ] Railway Bucket provisioned; credentials valid
- [ ] timescaledb image builds (CI green)
- [ ] `SHOW shared_preload_libraries;` includes `timescaledb`
- [ ] `SHOW archive_mode;` → `on`
- [ ] `stanza-create` succeeds; first full completes; appears in `pgbackrest info`
- [ ] `pgbackrest check` passes

### Post-deploy checklist

- [ ] Differential runs on schedule (wait 6h)
- [ ] `pgbackrest verify` passes
- [ ] Metrics file written at `/tmp/pgbackrest-metrics.prom`
- [ ] No `ERROR:` lines after 24h
- [ ] **Restore drill within 1 week**: Scenario A into a throwaway service, `pnpm test:integration` green, timings documented

```

```
