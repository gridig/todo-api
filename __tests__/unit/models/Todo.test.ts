import {
  connectTestDB,
  disconnectTestDB,
  generateUniqueId,
} from '../../helpers/testSetup.js';
import TodoService from '../../../models/Todo.js';
import UserService from '../../../models/User.js';
import type { User } from '../../../types/index.js';

let savedUser: User;

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await TodoService.deleteMany();
  await UserService.deleteMany();
});

beforeEach(async () => {
  savedUser = await UserService.create({
    email: `test-${generateUniqueId()}@example.com`,
    password: 'TestPassword123!',
  });
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('Todo Service', () => {
  describe('Create Todo', () => {
    it('should default done to false when not specified', async () => {
      const todo = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
      });

      expect(todo.done).toBe(false);
    });

    it('should auto-generate timestamps', async () => {
      const todo = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
      });

      expect(todo.createdAt).toBeInstanceOf(Date);
      expect(todo.updatedAt).toBeInstanceOf(Date);
    });

    it('should create todo with provided done value', async () => {
      const todo = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
        done: true,
      });

      expect(todo.done).toBe(true);
    });
  });

  describe('Find Todos', () => {
    it('should find all todos for a user', async () => {
      await TodoService.create({ text: 'Todo 1', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 2', userId: savedUser.id });

      const result = await TodoService.findByUser(savedUser.id);

      expect(result.data).toHaveLength(2);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('should paginate with limit', async () => {
      await TodoService.create({ text: 'Todo 1', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 2', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 3', userId: savedUser.id });

      const result = await TodoService.findByUser(savedUser.id, { limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.meta.hasMore).toBe(true);
      expect(result.meta.nextCursor).not.toBeNull();
    });

    it('should navigate pages using cursor', async () => {
      await TodoService.create({ text: 'Todo 1', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 2', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 3', userId: savedUser.id });

      const firstPage = await TodoService.findByUser(savedUser.id, {
        limit: 2,
      });
      const cursor = firstPage.meta.nextCursor as string;

      const secondPage = await TodoService.findByUser(savedUser.id, {
        limit: 2,
        cursor,
      });

      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.meta.hasMore).toBe(false);
      expect(secondPage.meta.nextCursor).toBeNull();

      const firstIds = firstPage.data.map((t) => t.id);
      const secondIds = secondPage.data.map((t) => t.id);
      expect(firstIds).not.toEqual(expect.arrayContaining(secondIds));
    });

    it('should return empty data with no cursor when user has no todos', async () => {
      const result = await TodoService.findByUser(savedUser.id);

      expect(result.data).toHaveLength(0);
      expect(result.meta.hasMore).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it('should find a specific todo', async () => {
      const created = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
      });

      const found = await TodoService.findOne({
        id: created.id,
        userId: savedUser.id,
      });

      expect(found).not.toBeNull();
      expect(found?.text).toBe('Test Todo');
    });
  });

  describe('Update Todo', () => {
    it('should toggle done status', async () => {
      const todo = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
      });

      const toggled = await TodoService.toggleDone({
        id: todo.id,
        userId: savedUser.id,
      });

      expect(toggled?.done).toBe(true);
    });

    it('should return null when toggling non-existent todo', async () => {
      const result = await TodoService.toggleDone({
        id: '00000000-0000-0000-0000-000000000000',
        userId: savedUser.id,
      });
      expect(result).toBeNull();
    });
  });

  describe('Delete Todo', () => {
    it('should delete a todo', async () => {
      const todo = await TodoService.create({
        text: 'Test Todo',
        userId: savedUser.id,
      });

      await TodoService.delete({ id: todo.id, userId: savedUser.id });

      const found = await TodoService.findOne({
        id: todo.id,
        userId: savedUser.id,
      });
      expect(found).toBeNull();
    });

    it('should delete all todos for a specific user', async () => {
      await TodoService.create({ text: 'Todo 1', userId: savedUser.id });
      await TodoService.create({ text: 'Todo 2', userId: savedUser.id });

      await TodoService.deleteManyByUser(savedUser.id);

      const result = await TodoService.findByUser(savedUser.id);
      expect(result.data).toHaveLength(0);
    });

    it('should return null when deleting non-existent todo', async () => {
      const result = await TodoService.delete({
        id: '00000000-0000-0000-0000-000000000000',
        userId: savedUser.id,
      });
      expect(result).toBeNull();
    });
  });
});
