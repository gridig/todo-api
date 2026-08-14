import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';
import { auth } from '@/middleware/auth.js';
import { env } from '@/config/env.js';

// Mint a token the middleware accepts: correct secret + iss + aud.
const signValid = (payload: object, opts: jwt.SignOptions = {}): string =>
  jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ...opts,
  });

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
      log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
      ip: '127.0.0.1',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it('should authenticate a valid token (sub + iss + aud)', () => {
    const token = signValid({ sub: '123' });
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
      }),
    );
  });

  it('treats an oversized Authorization header as no token (DoS cap)', () => {
    // MAX_AUTH_HEADER_LEN (8 KiB) — an attacker-controlled multi-MB header must
    // be dropped before toLowerCase(), not parsed. Expect the NO_TOKEN path.
    req.header.mockReturnValue(`Bearer ${'a'.repeat(9000)}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'NO_TOKEN' }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
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
      }),
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
      }),
    );
  });

  it('should reject expired JWT token', () => {
    const expiredToken = signValid({ sub: '123' }, { expiresIn: '-1h' }); // Past the 5s clockTolerance
    req.header.mockReturnValue(`Bearer ${expiredToken}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject token signed with wrong secret', () => {
    const token = jwt.sign({ sub: '123' }, 'wrong-secret', {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
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

  it('should accept lowercase "bearer" scheme (RFC 7235 case-insensitive)', () => {
    const token = signValid({ sub: '123' });
    req.header.mockReturnValue(`bearer ${token}`);

    auth(req, res, next);

    expect(req.userId).toBe('123');
    expect(next).toHaveBeenCalled();
  });

  it('should reject token with alg=none (algorithm confusion)', () => {
    // jsonwebtoken refuses to sign with alg=none unless explicitly allowed; craft manually.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: '123', iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE }),
    ).toString('base64url');
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
    const token = jwt.sign({ sub: '123' }, env.JWT_SECRET, {
      algorithm: 'HS512',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
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
    const token = signValid({ sub: '123' });
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(req.userId).toBe('123');
    expect(next).toHaveBeenCalled();
  });

  it('should reject token with no sub claim', () => {
    const token = signValid({ some: 'other-claim' });
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

  it('should reject a legacy { userId } token (no sub/iss/aud) with INVALID_TOKEN', () => {
    // Back-compat path removed: pre-rollout tokens no longer verify.
    const token = jwt.sign({ userId: '123' }, env.JWT_SECRET, { algorithm: 'HS256' });
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

  it('should reject a token missing the aud claim', () => {
    const token = jwt.sign({ sub: '123' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
    });
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject a token missing the iss claim', () => {
    const token = jwt.sign({ sub: '123' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      audience: env.JWT_AUDIENCE,
    });
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject a token with the wrong aud claim', () => {
    const token = jwt.sign({ sub: '123' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: 'someone-else',
    });
    req.header.mockReturnValue(`Bearer ${token}`);

    auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
