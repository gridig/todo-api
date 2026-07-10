import { jest } from '@jest/globals';

// The unscoped deleteMany wipes are test-suite cleanup helpers; outside
// NODE_ENV=test they must throw before touching the database.

jest.unstable_mockModule('@/config/env.js', () => ({
  env: {
    NODE_ENV: 'production',
    // User.js → fieldCrypto → keyProvider builds EnvKeyProvider(env) at load.
    ENCRYPTION_KEYRING: 'k1:xUDmpBXSU0GOwiXb21JUx+TmbrLCvRq2H/FnzNHpa8k=',
    ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    ENCRYPTION_BLIND_INDEX_KEY: '77aSVJcRkCMYdHdn/ZgEUhWU035vPNWcvuPPbAgN1/Y=',
  },
}));

const userDeleteMany = jest.fn();
const todoDeleteMany = jest.fn();

jest.unstable_mockModule('@/lib/prisma.js', () => ({
  default: {
    user: { deleteMany: userDeleteMany },
    todo: { deleteMany: todoDeleteMany },
  },
}));

jest.unstable_mockModule('@/lib/auditLog.js', () => ({
  default: { write: jest.fn(), writeOrLog: jest.fn() },
  write: jest.fn(),
  writeOrLog: jest.fn(),
}));

describe('deleteMany guards outside NODE_ENV=test', () => {
  it('UserService.deleteMany throws and never reaches Prisma', async () => {
    const { default: UserService } = await import('@/models/User.js');
    await expect(UserService.deleteMany()).rejects.toThrow(/test-only/);
    expect(userDeleteMany).not.toHaveBeenCalled();
  });

  it('TodoService.deleteMany throws and never reaches Prisma', async () => {
    const { default: TodoService } = await import('@/models/Todo.js');
    await expect(TodoService.deleteMany()).rejects.toThrow(/test-only/);
    expect(todoDeleteMany).not.toHaveBeenCalled();
  });
});
