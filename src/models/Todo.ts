import prisma from '../lib/prisma.js';
import auditLog from '../lib/auditLog.js';
import { env } from '../config/env.js';
import { AuditAction } from '../lib/auditActions.js';
import type {
  Todo,
  TodoServiceInterface,
  PaginationParams,
  PaginatedResult,
} from '../types/index.js';

export const TodoService: TodoServiceInterface = {
  async create({ text, userId, done }) {
    return prisma.$transaction(async (tx) => {
      const todo = await tx.todo.create({
        data: {
          text: text.trim(),
          userId,
          ...(done !== undefined && { done }),
        },
      });
      await auditLog.write(tx, {
        action: AuditAction.TodoCreate,
        outcome: 'success',
        entityType: 'Todo',
        entityId: todo.id,
        changedBy: userId,
        newValue: { id: todo.id, text: todo.text, done: todo.done },
      });
      return todo;
    });
  },

  async findByUser(userId: string, params: PaginationParams = {}): Promise<PaginatedResult<Todo>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const todos = await prisma.todo.findMany({
      where: { userId },
      // id breaks createdAt ties. created_at is TIMESTAMP(3), so burst inserts
      // collide readily, and without a unique tiebreaker the order within a tie
      // group is undefined per query — a page boundary landing inside one drops
      // or repeats rows.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
    });
    const hasMore = todos.length > limit;
    const data = hasMore ? todos.slice(0, limit) : todos;
    return {
      data,
      meta: {
        nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
        hasMore,
      },
    };
  },

  async findOne({ id, userId }) {
    return prisma.todo.findFirst({
      where: { id, userId },
    });
  },

  // Unpaginated: the data-export endpoint needs the user's complete todo set.
  async findAllByUser(userId) {
    return prisma.todo.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  },

  async toggleDone({ id, userId }) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<Todo[]>`
        UPDATE todos
        SET done = NOT done, updated_at = NOW()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING
          id,
          text,
          done,
          user_id AS "userId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const todo = result[0];
      if (!todo) return null;
      // Boolean flip — previous_value is derivable from new_value.done, so
      // skipping it avoids the CTE + FOR UPDATE machinery a non-boolean PATCH
      // would need to snapshot the prior row atomically.
      await auditLog.write(tx, {
        action: AuditAction.TodoUpdate,
        outcome: 'success',
        entityType: 'Todo',
        entityId: todo.id,
        changedBy: userId,
        newValue: { id: todo.id, done: todo.done },
      });
      return todo;
    });
  },

  async delete({ id, userId }) {
    return prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<Todo[]>`
        DELETE FROM todos
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING
          id,
          text,
          done,
          user_id AS "userId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
      const todo = result[0];
      if (!todo) return null;
      await auditLog.write(tx, {
        action: AuditAction.TodoDelete,
        outcome: 'success',
        entityType: 'Todo',
        entityId: todo.id,
        changedBy: userId,
        previousValue: { id: todo.id, text: todo.text, done: todo.done },
      });
      return todo;
    });
  },

  // Unscoped wipe — test-suite cleanup only. Guarded so a stray call can never
  // truncate a real environment. Production code paths use deleteManyByUser.
  async deleteMany(filter = {}) {
    if (env.NODE_ENV !== 'test') {
      throw new Error('TodoService.deleteMany is test-only: default filter deletes every todo');
    }
    return prisma.todo.deleteMany({ where: filter });
  },

  async deleteManyByUser(userId) {
    return prisma.todo.deleteMany({ where: { userId } });
  },
};

export default TodoService;
