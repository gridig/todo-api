import type { Todo } from '../../types/index.js';
import TodoService from '../../models/Todo.js';
import { randomUUID } from 'crypto';

// Create test todos with specific data
export async function createTestTodos(userId: string, count: number = 2): Promise<Todo[]> {
  const todos = [];
  for (let i = 1; i <= count; i++) {
    const todo = await TodoService.create({
      text: `Test Todo ${i}`,
      userId,
      done: i % 2 === 0, // Every other todo is completed
    });
    todos.push(todo);
  }
  return todos;
}

// Create a single test todo
export async function createTestTodo(userId: string, text: string = 'Test Todo', done: boolean = false): Promise<Todo> {
  return TodoService.create({ text, userId, done });
}

// Generate fake UUID for testing
export function generateFakeUUID(): string {
  return randomUUID();
}
