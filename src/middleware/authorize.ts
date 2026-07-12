import { Response, NextFunction } from 'express';
import UserService from '../models/User.js';
import { requireUserId } from './auth.js';
import { ForbiddenError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type { RequestWithLogger, UserRole } from '../types/index.js';

// Role gate for privileged routes. Deliberately kept separate from `auth` so the
// auth middleware stays DB-free on the hot path — this runs only on the
// low-traffic admin surface and fetches the CURRENT role per request, so a
// demotion revokes access immediately (no stale JWT claim to wait out).
//
// Throws ForbiddenError (→ 403 via the global errorHandler) on mismatch and
// records an access.denied audit event so escalation attempts are visible
// (SOC 2 CC7.2). Must be mounted after `auth`, which sets req.userId.
export const requireRole = (role: UserRole) => {
  return async (req: RequestWithLogger, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = requireUserId(req);
      const actual = await UserService.getRole(userId);
      if (actual !== role) {
        req.log.warn(
          { userId, requiredRole: role, actualRole: actual, path: req.path },
          'Authorization failed - insufficient role',
        );
        void writeOrLog(
          prisma,
          {
            action: AuditAction.AccessDenied,
            outcome: 'failure',
            outcomeReason: 'insufficient-role',
            entityType: 'User',
            entityId: userId,
            changedBy: userId,
            metadata: { path: req.path, requiredRole: role },
          },
          req.log,
        );
        throw new ForbiddenError('Administrator role required', 'FORBIDDEN');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
};

export const requireAdmin = requireRole('admin');
