import type { Logger } from 'pino';
import { Prisma } from '../../prisma/generated/prisma/client.js';
import { auditWriteFailuresTotal } from '../middleware/metrics.js';
import { getRequestContext } from './requestContext.js';

// Structural shape that matches both the base PrismaClient, the $extends-wrapped
// client exported from lib/prisma.ts, and Prisma.TransactionClient. Narrower
// types from these three diverge under exactOptionalPropertyTypes; this only
// asks for what the callsite actually uses.
type AuditClient = {
  auditEntry: {
    create(args: { data: Prisma.AuditEntryCreateInput }): Promise<unknown>;
  };
};

export interface AuditEvent {
  action: string;
  entityType?: string;
  entityId?: string | null;
  outcome: 'success' | 'failure';
  outcomeReason?: string | null;
  changedBy?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  previousValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
}

export async function write(client: AuditClient, event: AuditEvent): Promise<void> {
  const ctx = getRequestContext();
  await client.auditEntry.create({
    data: {
      action: event.action,
      entityType: event.entityType ?? 'unknown',
      entityId: event.entityId ?? null,
      outcome: event.outcome,
      outcomeReason: event.outcomeReason ?? null,
      changedBy: event.changedBy ?? ctx?.userId ?? null,
      sourceIp: event.sourceIp ?? ctx?.ip ?? null,
      userAgent: event.userAgent ?? ctx?.userAgent ?? null,
      requestId: event.requestId ?? ctx?.requestId ?? null,
      previousValue: event.previousValue ?? Prisma.DbNull,
      newValue: event.newValue ?? Prisma.DbNull,
      metadata: event.metadata ?? Prisma.DbNull,
    },
  });
}

// Non-blocking variant for events that have no surrounding $transaction to
// roll back (auth: login/register/no-token/invalid-token). Failures bump the
// `audit_write_failures_total` Prometheus counter and log, but do not throw —
// a successful login that fails to audit is still a successful login.
// Mutation writes must call `write` directly inside `prisma.$transaction`
// so a DB-side rejection rolls back the parent mutation.
export async function writeOrLog(
  client: AuditClient,
  event: AuditEvent,
  log: Logger,
): Promise<void> {
  try {
    await write(client, event);
  } catch (err) {
    auditWriteFailuresTotal.inc({ reason: 'write_failed' });
    log.error({ err, action: event.action }, 'audit log write failed');
  }
}

// Default export is a plain runtime object so callsites that need to mock
// `write` (rollback tests, fault-injection benchmarks) can use `jest.spyOn`
// — ESM namespace bindings from `import *` are read-only and refuse spies.
const auditLog = { write, writeOrLog };
export default auditLog;
