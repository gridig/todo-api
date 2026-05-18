import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';
import { auth } from '../../../middleware/auth.js';

describe('Auth Middleware', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let req: any;
  let res: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      header: jest.fn(),
      id: 'test-request-id',
      log: { warn: jest.fn() },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it('should authenticate valid token', () => {
    const token = jwt.sign({ userId: '123' }, process.env.JWT_SECRET as string);
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(req.userId).toBe('123');
    expect(next).toHaveBeenCalled();
  });

  it('should reject missing token', () => {
    req.header.mockReturnValue(null);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'NO_TOKEN',
          message: 'No authentication token provided',
        }),
        requestId: 'test-request-id',
      })
    );
  });

  it('should reject invalid token', () => {
    req.header.mockReturnValue('Bearer invalid-token');

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        }),
        requestId: 'test-request-id',
      })
    );
  });

  it('should reject malformed Authorization header', () => {
    req.header.mockReturnValue('NotBearer token'); // Missing "Bearer "

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should reject Bearer header with no token', () => {
    req.header.mockReturnValue('Bearer '); // Just "Bearer " with no token

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'NO_TOKEN',
          message: 'No authentication token provided',
        }),
      })
    );
  });

  it('should handle JWT verification errors', () => {
    req.header.mockReturnValue('Bearer expired-or-malformed-token');

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        }),
      })
    );
  });

  it('should reject expired JWT token', () => {
    const expiredToken = jwt.sign(
      { userId: '123' },
      process.env.JWT_SECRET as string,
      { expiresIn: '-1h' } // Far past the 5s clockTolerance
    );
    req.header.mockReturnValue(`Bearer ${expiredToken}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject token signed with wrong secret', () => {
    const token = jwt.sign({ userId: '123' }, 'wrong-secret');
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_TOKEN',
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept lowercase "bearer" scheme (RFC 7235 case-insensitive)', () => {
    const token = jwt.sign({ userId: '123' }, process.env.JWT_SECRET as string);
    req.header.mockReturnValue(`bearer ${token}`);

    auth(req, res, next);

    expect(req.userId).toBe('123');
    expect(next).toHaveBeenCalled();
  });

  it('should reject token with alg=none (algorithm confusion)', () => {
    // jsonwebtoken refuses to sign with alg=none unless explicitly allowed; craft manually.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .toString('base64url');
    const payload = Buffer.from(JSON.stringify({ userId: '123' }))
      .toString('base64url');
    const unsignedToken = `${header}.${payload}.`;
    req.header.mockReturnValue(`Bearer ${unsignedToken}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject token signed with HS512 when only HS256 is allowed', () => {
    const token = jwt.sign(
      { userId: '123' },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS512' },
    );
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept token with sub claim (RFC-7519 subject)', () => {
    const token = jwt.sign({ sub: '123' }, process.env.JWT_SECRET as string);
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(req.userId).toBe('123');
    expect(next).toHaveBeenCalled();
  });

  it('should reject token whose payload has neither sub nor userId', () => {
    const token = jwt.sign(
      { some: 'other-claim' },
      process.env.JWT_SECRET as string,
    );
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject token whose userId is not a string', () => {
    const token = jwt.sign(
      { userId: 123 },
      process.env.JWT_SECRET as string,
    );
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
