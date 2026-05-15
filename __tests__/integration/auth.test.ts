import request from 'supertest';
import UserService from '../../models/User.js';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
} from '../helpers/testSetup.js';
import { jest } from '@jest/globals';

const app = createTestApp();

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await UserService.deleteMany();
});

afterAll(async () => {
  await disconnectTestDB();
});

describe('Authentication Endpoints', () => {
  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const response = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      if (response.status !== 201) {
        console.log('Error response:', response.body);
      }

      expect(response.status).toBe(201);
      expect(response.body.token).toBeDefined();
    });

    it('should reject weak password', async () => {
      const response = await request(app).post('/auth/register').send({
        email: 'test@example.com',
        password: 'weak',
      });

      expect(response.status).toBe(400);
    });

    it('should reject duplicate email registration', async () => {
      // First, create a user
      await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'TestPass123!',
      });

      // Try to register again with the same email
      const response = await request(app).post('/auth/register').send({
        email: 'duplicate@example.com',
        password: 'AnotherPass123!',
      });

      expect(response.status).toBe(409);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe('DUPLICATE_EMAIL');
      expect(response.body.error.message).toBe('Email already exists');
    });
  });

  describe('POST /auth/login', () => {
    it('should login a user', async () => {
      await UserService.create({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      const response = await request(app).post('/auth/login').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
    });

    it('should reject invalid credentials (wrong password)', async () => {
      // First, create a user with known credentials
      await UserService.create({
        email: 'existing@example.com',
        password: 'CorrectPass123!',
      });

      // Now try to login with WRONG password
      const response = await request(app).post('/auth/login').send({
        email: 'existing@example.com',
        password: 'WrongPassword123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid email or password');
    });

    it('should reject invalid email', async () => {
      const response = await request(app).post('/auth/login').send({
        email: 'invalidemail',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(400);
    });

    it('should reject non-existent user', async () => {
      const response = await request(app).post('/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid email or password');
    });

    it('should treat emails as case-insensitive', async () => {
      await request(app).post('/auth/register').send({
        email: 'Test@EXAMPLE.com',
        password: 'TestPass123!',
      });

      const response = await request(app).post('/auth/login').send({
        email: 'test@example.com',
        password: 'TestPass123!',
      });

      expect(response.status).toBe(200);
      expect(response.body.token).toBeDefined();
    });
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should handle unexpected error during registration', async () => {
    const spy = jest
      .spyOn(UserService, 'create')
      .mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app).post('/auth/register').send({
      email: 'test@example.com',
      password: 'TestPass123!',
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');

    spy.mockRestore();
  });

  it('should handle unexpected error during login', async () => {
    const spy = jest
      .spyOn(UserService, 'findByEmail')
      .mockRejectedValue(new Error('Database connection failed'));

    const response = await request(app).post('/auth/login').send({
      email: 'test@example.com',
      password: 'TestPass123!',
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');

    spy.mockRestore();
  });
});
