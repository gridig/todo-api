import prisma from '../lib/prisma.js';
import type { Todo, TodoServiceInterface, PaginationParams, PaginatedResult } from '../types/index.js';

export const TodoService: TodoServiceInterface = {
  async create({ text, userId, done }) {
    return prisma.todo.create({
      data: {
        text: text.trim(),
        userId,
        ...(done !== undefined && { done }),
      },
    });
  },

  async findByUser(userId: string, params: PaginationParams = {}): Promise<PaginatedResult<Todo>> {
    const limit = Math.min(params.limit ?? 20, 100);
    const todos = await prisma.todo.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
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

  async toggleDone({ id, userId }) {
    const result = await prisma.$queryRaw<Todo[]>`
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
    return result[0] ?? null;
  },

  async delete({ id, userId }) {
    const result = await prisma.$queryRaw<Todo[]>`
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
    return result[0] ?? null;
  },

  async deleteMany(filter = {}) {
    return prisma.todo.deleteMany({ where: filter });
  },

  async deleteManyByUser(userId) {
    return prisma.todo.deleteMany({ where: { userId } });
  },
};

export default TodoService;
