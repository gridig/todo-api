import express, { Request, Response, Router } from 'express';
import TodoService from '../models/Todo.js';
import { auth, requireUserId } from '../middleware/auth.js';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter.js';
import { validate, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { TodoNotFoundError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type { CreateTodoRequest, PaginationParams, RequestWithLogger } from '../types/index.js';

// Handlers throw typed AppErrors and rely on Express 5 async error forwarding +
// the global errorHandler (same style as routes/user.ts and routes/admin.ts) —
// so transient DB failures get classified to 503 + Retry-After by
// classifyPrismaError instead of a blanket 500.
const router: Router = express.Router();

// Cross-user vs truly-missing is indistinguishable to the client (both 404),
// but the audit row preserves the distinction for security review via
// entity_id — analysts can cross-reference IDs across users.
const auditTodoDenied = (req: Request<{ id: string }>, userId: string): void => {
  void writeOrLog(
    prisma,
    {
      action: AuditAction.AccessDenied,
      outcome: 'failure',
      entityType: 'Todo',
      entityId: req.params.id,
      changedBy: userId,
    },
    (req as unknown as RequestWithLogger).log,
  );
};

// GET all todos
router.get(
  '/',
  auth,
  readLimiter,
  validateQuery(schemas.pagination),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const params: PaginationParams = {
      ...(req.query.limit !== undefined && { limit: Number(req.query.limit) }),
      ...(req.query.cursor !== undefined && { cursor: req.query.cursor as string }),
    };
    const result = await TodoService.findByUser(userId, params);

    log.info(
      { userId, count: result.data.length, hasMore: result.meta.hasMore },
      'Todos fetched successfully',
    );
    res.json(result);
  },
);

// POST create todo
router.post(
  '/',
  auth,
  writeLimiter,
  validate(schemas.todo),
  async (req, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const { text } = req.body as CreateTodoRequest;
    const newTodo = await TodoService.create({ text, userId });

    log.info({ todoId: newTodo.id, userId }, 'Todo created successfully');
    res.status(201).json(newTodo);
  },
);

// GET single todo
router.get(
  '/:id',
  auth,
  readLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const todo = await TodoService.findOne({ id: req.params.id, userId });

    if (!todo) {
      log.warn({ todoId: req.params.id, userId }, 'Todo not found');
      auditTodoDenied(req, userId);
      throw new TodoNotFoundError();
    }

    log.info({ todoId: todo.id, userId }, 'Todo fetched successfully');
    res.json(todo);
  },
);

// PATCH toggle todo
router.patch(
  '/:id',
  auth,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const updatedTodo = await TodoService.toggleDone({ id: req.params.id, userId });

    if (!updatedTodo) {
      log.warn({ todoId: req.params.id, userId }, 'Todo not found for toggle');
      auditTodoDenied(req, userId);
      throw new TodoNotFoundError();
    }

    log.info(
      {
        todoId: updatedTodo.id,
        userId,
        previousStatus: !updatedTodo.done,
        newStatus: updatedTodo.done,
      },
      'Todo status toggled successfully',
    );
    res.json(updatedTodo);
  },
);

// DELETE todo
router.delete(
  '/:id',
  auth,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log } = req as RequestWithLogger;
    const userId = requireUserId(req);
    const todo = await TodoService.delete({ id: req.params.id, userId });

    if (!todo) {
      log.warn({ todoId: req.params.id, userId }, 'Todo not found for deletion');
      auditTodoDenied(req, userId);
      throw new TodoNotFoundError();
    }

    log.info({ todoId: todo.id, userId }, 'Todo deleted successfully');
    res.status(204).end();
  },
);

export default router;
