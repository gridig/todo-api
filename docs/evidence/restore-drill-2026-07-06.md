# Restore Drill Report — SOC 2 A1.3 (Recovery Testing)

> Evidence that a pgBackRest backup was successfully restored and verified.
> Procedure: [operations.md → Quarterly restore drill](../operations.md#quarterly-restore-drill-soc-2-a13).

## Summary

| Field | Value |
| ----- | ----- |
| Drill date (UTC) | 2026-07-06 |
| Operator | Igor Abdulović |
| Outcome | ☑ PASS |
| Backup ID restored | `20260706-020047F_20260706-031042D` (02:00 full + 03:10 diff) |
| Backup type | ☑ full + WAL to latest |
| Restore target time (if PITR) | n/a — latest |
| Source repo | Railway Bucket `shelved-briefcase-fi-blbz`, stanza `todo-api` |
| Isolation | Full read/write isolation — repo copied to scratch bucket `todo-api-drill-nsm2kfjvz0`; drill ran in the **staging** environment; **production untouched** |

## Recovery objectives (achieved vs target)

| Metric | Target | Achieved | Pass? |
| ------ | ------ | -------- | ----- |
| RTO (container start → DB ready to accept connections) | ≤ 30 min | ~112 s (09:58:03 → 09:59:55 UTC) | ☑ |
| RPO (replay reached newest archived WAL) | ≤ 5 min | replayed to last committed txn `2026-07-06 06:00:00` UTC; WAL replay stopped only at the end of the archive (segment `…000034` not yet present) → no recoverable data left behind | ☑ |

- WAL replay duration: 89.0 s (redo done at LSN `3/33000090`).
- New timeline selected: 2 (`archive recovery complete`).

> RTO here measures restore-to-DB-ready. The app-repoint + `/health/ready` leg was **not** exercised
> in this drill (see caveat), so real end-to-end RTO would be slightly higher; still far inside 30 min.

## Verification checklist

| Check | Command | Expected | Result |
| ----- | ------- | -------- | ------ |
| Restore mode ran | (deploy logs) | `=== RESTORE MODE: restoring 'todo-api' ...` | ☑ |
| WAL replay + promote | (deploy logs) | `database system is ready to accept connections` | ☑ |
| Roles present | `\du` | `db_admin`, `db_app`, `db_auditor` (+ `railway`) | ☑ |
| Tables present | `\dt` | `users`, `todos`, `audit_entries`, `_prisma_migrations` (owner `db_admin`) | ☑ |
| Audit hypertable schema | `\d audit_entries` | full column set + 6 indexes + `(id, changed_at)` PK | ☑ |
| Row counts | `SELECT count(*) ...` | users **0**, todos **0**, audit_entries **0** — source DB was empty (see caveat) | ☑ (structural) |
| **Audit immutability** | `SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;` | fails `42501` | ☑ `permission denied for table audit_entries` |
| App startup | (scratch `todo-api`) | not run — see caveat | ☐ n/a |
| Integration tests | `pnpm test:integration` | not run — see caveat | ☐ n/a |

## Teardown

| Item | Removed? |
| ---- | -------- |
| Scratch `todo-api` app | n/a (app-level leg not run) |
| `timescaledb-drill` service + volume | ☑ |
| Scratch bucket `todo-api-drill-nsm2kfjvz0` | ☑ |

## Notes / caveats

- **Empty source data.** Every table restored with 0 rows because the source DB genuinely held no
  data (backup size 34.4MB = TimescaleDB base + schema only). This drill therefore proves the full
  **recovery mechanism** — image, restore-mode entrypoint, WAL replay, timeline promotion, physical
  role recovery (`pg_authid`), schema recovery, and audit-immutability survival — but **not row-level
  data fidelity**, since there were no rows to compare. Once production carries real data, re-run to
  add a row-count-match assertion.
- **App-level leg skipped.** The scratch-app + `pnpm test:integration` step was not run; the restore,
  role, schema, and immutability checks are the core evidence and all passed.
- **Expected error noise (cosmetic):** the drill service logged `role "postgres" does not exist` and
  `Full/Differential backup FAILED` — the scheduler tried to take *new* backups connecting as
  `postgres`, but the restored cluster (Railway-origin) has superuser `railway`, not `postgres`. This
  does not affect the restore. Tracked as a backlog fix (`PGBACKREST_PG1_USER=railway`). The
  `environment contains invalid option 'restore'` WARN is pgBackRest reading the `PGBACKREST_RESTORE`
  gate env as a config option — also cosmetic, tracked separately.
