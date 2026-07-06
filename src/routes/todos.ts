import express, { Request, Response, Router } from 'express';
import TodoService from '../models/Todo.js';
import { auth, requireUserId } from '../middleware/auth.js';
import { readLimiter, writeLimiter } from '../middleware/rateLimiter.js';
import { validate, validateQuery, validateParams, schemas } from '../middleware/validation.js';
import { TodoNotFoundError, InternalServerError } from '../errors/index.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type { CreateTodoRequest, PaginationParams, RequestWithLogger } from '../types/index.js';

const router: Router = express.Router();

// GET all todos
router.get(
  '/',
  auth,
  readLimiter,
  validateQuery(schemas.pagination),
  async (req, res: Response): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const userId = requireUserId(req);
    try {
      const params: PaginationParams = {
        ...(req.query.limit !== undefined && { limit: Number(req.query.limit) }),
        ...(req.query.cursor !== undefined && { cursor: req.query.cursor as string }),
      };
      const result = await TodoService.findByUser(userId, params);

      log.info(
        {
          userId,
          count: result.data.length,
          hasMore: result.meta.hasMore,
        },
        'Todos fetched successfully',
      );

      res.json(result);
    } catch (err: unknown) {
      log.error(
        {
          err,
          userId,
        },
        'Failed to fetch todos',
      );

      const error = new InternalServerError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
    }
  },
);

// POST create todo
router.post(
  '/',
  auth,
  writeLimiter,
  validate(schemas.todo),
  async (req, res: Response): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const userId = requireUserId(req);
    try {
      const { text } = req.body as CreateTodoRequest;
      const newTodo = await TodoService.create({ text, userId });

      log.info(
        {
          todoId: newTodo.id,
          userId,
        },
        'Todo created successfully',
      );

      res.status(201).json(newTodo);
    } catch (err: unknown) {
      log.error(
        {
          err,
          userId,
          body: req.body,
        },
        'Failed to create todo',
      );

      const error = new InternalServerError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
    }
  },
);

// GET single todo
router.get(
  '/:id',
  auth,
  readLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const userId = requireUserId(req);
    try {
      const todo = await TodoService.findOne({
        id: req.params.id,
        userId,
      });
      if (!todo) {
        log.warn(
          {
            todoId: req.params.id,
            userId,
          },
          'Todo not found',
        );
        // Cross-user vs truly-missing is indistinguishable to the client (both
        // 404), but the audit row preserves the distinction for security review
        // via entity_id — analysts can cross-reference IDs across users.
        void writeOrLog(
          prisma,
          {
            action: AuditAction.AccessDenied,
            outcome: 'failure',
            entityType: 'Todo',
            entityId: req.params.id,
            changedBy: userId,
          },
          log,
        );
        const error = new TodoNotFoundError();
        res.status(error.statusCode).json({
          ...error.toJSON(),
          requestId,
        });
        return;
      }

      log.info(
        {
          todoId: todo.id,
          userId,
        },
        'Todo fetched successfully',
      );

      res.json(todo);
    } catch (err: unknown) {
      log.error(
        {
          err,
          todoId: req.params.id,
          userId,
        },
        'Failed to fetch todo',
      );

      const error = new InternalServerError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
    }
  },
);

// PATCH toggle todo
router.patch(
  '/:id',
  auth,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const userId = requireUserId(req);
    try {
      const updatedTodo = await TodoService.toggleDone({
        id: req.params.id,
        userId,
      });

      if (!updatedTodo) {
        log.warn(
          {
            todoId: req.params.id,
            userId,
          },
          'Todo not found for toggle',
        );
        void writeOrLog(
          prisma,
          {
            action: AuditAction.AccessDenied,
            outcome: 'failure',
            entityType: 'Todo',
            entityId: req.params.id,
            changedBy: userId,
          },
          log,
        );

        const error = new TodoNotFoundError();
        res.status(error.statusCode).json({
          ...error.toJSON(),
          requestId,
        });
        return;
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
    } catch (err: unknown) {
      log.error(
        {
          err,
          todoId: req.params.id,
          userId,
        },
        'Failed to toggle todo',
      );

      const error = new InternalServerError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
    }
  },
);

// DELETE todo
router.delete(
  '/:id',
  auth,
  writeLimiter,
  validateParams(schemas.paramsSchema),
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    const { log, id: requestId } = req as RequestWithLogger;
    const userId = requireUserId(req);
    try {
      const todo = await TodoService.delete({
        id: req.params.id,
        userId,
      });

      if (!todo) {
        log.warn(
          {
            todoId: req.params.id,
            userId,
          },
          'Todo not found for deletion',
        );
        void writeOrLog(
          prisma,
          {
            action: AuditAction.AccessDenied,
            outcome: 'failure',
            entityType: 'Todo',
            entityId: req.params.id,
            changedBy: userId,
          },
          log,
        );
        const error = new TodoNotFoundError();
        res.status(error.statusCode).json({
          ...error.toJSON(),
          requestId,
        });
        return;
      }

      log.info(
        {
          todoId: todo.id,
          userId,
        },
        'Todo deleted successfully',
      );

      res.status(204).end();
    } catch (err: unknown) {
      log.error(
        {
          err,
          todoId: req.params.id,
          userId,
        },
        'Failed to delete todo',
      );

      const error = new InternalServerError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
    }
  },
);

export default router;
