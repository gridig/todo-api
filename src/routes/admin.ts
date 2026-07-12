import express, { Request, Response, Router } from 'express';
import UserService from '../models/User.js';
import { auth, requireUserId } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/authorize.js';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter.js';
import { validate, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { ForbiddenError, UserNotFoundError } from '../errors/index.js';
import type { PaginationParams, RequestWithLogger, UserRole } from '../types/index.js';

// Administrative user management. Every route is gated by `auth` (identifies the
// caller) then `requireAdmin` (fetches the caller's current role and 403s +
// audits access.denied on failure). Handlers throw typed AppErrors and rely on
// Express 5 async forwarding + the global errorHandler (same style as
// routes/user.ts).
const router: Router = express.Router();

// GET paginated user list.
router.get(
  '/users',
  auth,
  requireAdmin,
  readLimiter,
  validateQuery(schemas.pagination),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const adminId = requireUserId(req);
    const params: PaginationParams = {
      ...(req.query.limit !== undefined && { limit: Number(req.query.limit) }),
      ...(req.query.cursor !== undefined && { cursor: req.query.cursor as string }),
    };
    const result = await UserService.listUsers(params);
    log.info({ adminId, count: result.data.length, hasMore: result.meta.hasMore }, 'Admin listed users');
    res.json(result);
  },
);

// GET a single user by id.
router.get(
  '/users/:id',
  auth,
  requireAdmin,
  readLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const adminId = requireUserId(req);
    const user = await UserService.findById(req.params.id);
    if (!user) throw new UserNotFoundError();
    log.info({ adminId, targetId: req.params.id }, 'Admin fetched user');
    res.json(user);
  },
);

// PATCH a user's role.
router.patch(
  '/users/:id/role',
  auth,
  requireAdmin,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  validate(schemas.updateRole),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const adminId = requireUserId(req);
    const targetId = req.params.id;
    const { role } = req.body as { role: UserRole };

    // An admin can't change their own role — prevents self-lockout / accidental
    // self-demotion. Self-service account changes go through /user/me.
    if (targetId === adminId) {
      throw new ForbiddenError('Cannot change your own role via the admin API', 'FORBIDDEN');
    }

    const updated = await UserService.setRole(targetId, role, adminId);
    log.info({ adminId, targetId, role }, 'Admin changed user role');
    res.json(updated);
  },
);

// DELETE a user.
router.delete(
  '/users/:id',
  auth,
  requireAdmin,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const adminId = requireUserId(req);
    const targetId = req.params.id;

    if (targetId === adminId) {
      throw new ForbiddenError('Cannot delete your own account via the admin API', 'FORBIDDEN');
    }

    await UserService.adminDeleteUser(targetId, adminId);
    log.info({ adminId, targetId }, 'Admin deleted user');
    res.status(204).end();
  },
);

export default router;
