# Restore Drill Report — SOC 2 A1.3 (Recovery Testing)

> Copy this file to `docs/evidence/restore-drill-YYYY-MM-DD.md`, fill every field, and commit it.
> This is the auditable evidence that a production backup was successfully restored and verified.
> Procedure: [operations.md → Quarterly restore drill](operations.md#quarterly-restore-drill-soc-2-a13).

## Summary

| Field                         | Value                                                |
| ----------------------------- | ---------------------------------------------------- |
| Drill date (UTC)              | `YYYY-MM-DD`                                         |
| Operator                      |                                                      |
| Outcome                       | ☐ PASS ☐ FAIL                                        |
| Backup ID restored            | e.g. `20260706-020047F`                              |
| Backup type                   | ☐ full ☐ full + WAL to latest ☐ PITR (`--type=time`) |
| Restore target time (if PITR) |                                                      |
| Source repo                   | Railway Bucket `shelved-briefcase-fi-blbz` (prod)    |
| Isolation                     | Read-only S3 credentials on drill service            |

## Recovery objectives (achieved vs target)

| Metric                                                                      | Target   | Achieved | Pass? |
| --------------------------------------------------------------------------- | -------- | -------- | ----- |
| RTO (deploy trigger → first `/health/ready → 200`)                          | ≤ 30 min | `__ min` | ☐     |
| RPO (target `wal archive max` vs newest restored `audit_entries.createdAt`) | ≤ 5 min  | `__`     | ☐     |

- RTO clock start (UTC): `__:__:__`
- RTO clock stop (UTC): `__:__:__`
- `wal archive max` at target (step 1): `______`
- Newest `audit_entries.createdAt` after restore: `______`

## Verification checklist

| Check                | Command                                                             | Expected                                                                               | Result |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| Restore mode ran     | (deploy logs)                                                       | `=== RESTORE MODE: restoring 'todo-api' ...`                                           | ☐      |
| WAL replay + promote | (deploy logs)                                                       | `database system is ready to accept connections`                                       | ☐      |
| Roles present        | `psql -c '\du'`                                                     | `db_admin`, `db_app`, `db_auditor`                                                     | ☐      |
| Tables present       | `psql -c '\dt'`                                                     | `users`, `todos`, `audit_entries`, `_prisma_migrations`                                | ☐      |
| Row counts sane      | `SELECT count(*) FROM users; ... FROM todos;`                       | users `__`, todos `__` (≈ prod)                                                        | ☐      |
| Audit immutability   | `SET ROLE db_app; UPDATE audit_entries SET action='x' WHERE false;` | fails `42501`                                                                          | ☐      |
| Backup set confirmed | `pgbackrest --stanza=todo-api info`                                 | shows restored set                                                                     | ☐      |
| App startup          | (scratch `todo-api` logs)                                           | `preflight-roles: OK`, `Audit-log tamper-evidence probe passed`, `/health/ready → 200` | ☐      |
| Integration tests    | `pnpm test:integration`                                             | green — `__` passed / `__` failed                                                      | ☐      |

## Teardown

| Item                                 | Removed? |
| ------------------------------------ | -------- |
| Scratch `todo-api` service           | ☐        |
| `timescaledb-drill` service + volume | ☐        |

## Notes / anomalies

_Errors observed (e.g. expected read-only scheduler/archive `ERROR` noise), deviations from the runbook,
follow-up actions:_

-
