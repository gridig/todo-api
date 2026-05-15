import { connectTestDB, disconnectTestDB } from '../../helpers/testSetup.js';
import UserService from '../../../models/User.js';
import type { User } from '../../../types/index.js';

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await UserService.deleteMany();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('User Service', () => {
  it('should create a user with valid email and password', async () => {
    const savedUser: User = await UserService.create({
      email: 'test@example.com',
      password: 'TestPassword123!',
    });

    expect(savedUser.id).toBeDefined();
    expect(savedUser.email).toBe('test@example.com');
    expect(savedUser.password).not.toBe('TestPassword123!'); // Should be hashed
    expect(savedUser.createdAt).toBeDefined();
    expect(savedUser.updatedAt).toBeDefined();
  });

  it('should find user by email', async () => {
    await UserService.create({
      email: 'test@example.com',
      password: 'TestPassword123!',
    });

    const found = await UserService.findByEmail('test@example.com');

    expect(found).not.toBeNull();
    expect(found?.email).toBe('test@example.com');
  });

  it('should normalize email to lowercase', async () => {
    const user = await UserService.create({
      email: 'TEST@EXAMPLE.COM',
      password: 'TestPassword123!',
    });

    expect(user.email).toBe('test@example.com');
  });

  describe('Password Comparison', () => {
    it('should return true for correct password', async () => {
      const plainPassword = 'TestPassword123!';
      const user = await UserService.create({
        email: 'test@example.com',
        password: plainPassword,
      });

      const isMatch = await UserService.comparePassword(
        plainPassword,
        user.password
      );
      expect(isMatch).toBe(true);
    });

    it('should return false for incorrect password', async () => {
      const user = await UserService.create({
        email: 'test@example.com',
        password: 'TestPassword123!',
      });

      const isMatch = await UserService.comparePassword(
        'WrongPassword123!',
        user.password
      );
      expect(isMatch).toBe(false);
    });
  });

  describe('Password Hashing', () => {
    it('should hash password before saving', async () => {
      const plainPassword = 'TestPassword123!';
      const savedUser = await UserService.create({
        email: 'test@example.com',
        password: plainPassword,
      });

      // Password should be hashed
      expect(savedUser.password).not.toBe(plainPassword);
      expect(savedUser.password).toMatch(/^\$2[aby]?\$\d+\$/); // bcrypt pattern
      expect(savedUser.password.length).toBeGreaterThan(50);
    });
  });

  describe('Duplicate Email Handling', () => {
    it('should reject duplicate email', async () => {
      await UserService.create({
        email: 'test@example.com',
        password: 'TestPassword123!',
      });

      await expect(
        UserService.create({
          email: 'test@example.com',
          password: 'AnotherPass123!',
        })
      ).rejects.toThrow();
    });
  });
});
