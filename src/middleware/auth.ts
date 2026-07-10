import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { NoTokenError, InvalidTokenError, InternalServerError } from '../errors/index.js';
import { requestContext } from '../lib/requestContext.js';
import { writeOrLog } from '../lib/auditLog.js';
import { AuditAction } from '../lib/auditActions.js';
import prisma from '../lib/prisma.js';
import type { RequestWithLogger } from '../types/index.js';

// The only sanctioned way for handlers to read the authenticated user id.
// req.userId is optional on the global Request type, so a route accidentally
// mounted without the auth middleware would otherwise flow `undefined` into
// user-isolation query keys and silently match nothing. Throwing converts
// that wiring bug into a loud 500 at the first request.
export const requireUserId = (req: Request): string => {
  const { userId } = req as Request & { userId?: unknown };
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new InternalServerError();
  }
  return userId;
};

const TOKEN_REASON_MAX_LEN = 100;
// Generous cap — real JWTs run ~1–2 KiB. Treats oversized headers as empty so
// we never feed an attacker-controlled multi-MB string into toLowerCase().
const MAX_AUTH_HEADER_LEN = 8192;
const BEARER_SCHEME = 'bearer ';

export const auth = (req: RequestWithLogger, res: Response, next: NextFunction): void => {
  const { log, id: requestId } = req;
  try {
    const rawHeader = req.header('Authorization') ?? '';
    const authHeader = rawHeader.length > MAX_AUTH_HEADER_LEN ? '' : rawHeader;
    const token = authHeader.toLowerCase().startsWith(BEARER_SCHEME)
      ? authHeader.slice(BEARER_SCHEME.length).trim()
      : '';

    if (!token) {
      log.warn(
        {
          path: req.path,
          ip: req.ip,
        },
        'Authentication failed - no token provided',
      );
      void writeOrLog(
        prisma,
        { action: AuditAction.AuthNoToken, outcome: 'failure', outcomeReason: 'no-auth-header' },
        log,
      );
      const error = new NoTokenError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
      return;
    }

    // iss/aud are enforced unconditionally: every issued token carries them
    // (sign side in routes/auth.ts) and the legacy { userId } grace window has
    // closed. 5s clockTolerance absorbs small clock drift across instances.
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      clockTolerance: 5,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    if (typeof decoded !== 'object' || decoded === null) {
      throw new Error('Invalid JWT payload');
    }

    // Authenticated user id is the RFC-7519 `sub` claim.
    const payload = decoded as { sub?: unknown };
    const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (userId === undefined) {
      throw new Error('Invalid JWT payload');
    }

    (req as RequestWithLogger & { userId: string }).userId = userId;

    // Overlay userId onto the per-request ALS store so audit writes from
    // downstream handlers attribute the actor without explicit plumbing.
    const store = requestContext.getStore();
    if (store) {
      requestContext.enterWith({ ...store, userId });
    }

    next();
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, TOKEN_REASON_MAX_LEN) : 'unknown';
    log.warn(
      {
        err: reason, // Don't log full error (might contain token)
        path: req.path,
        ip: req.ip,
      },
      'Authentication failed - invalid token',
    );
    void writeOrLog(
      prisma,
      { action: AuditAction.AuthTokenInvalid, outcome: 'failure', outcomeReason: reason },
      log,
    );

    const error = new InvalidTokenError();
    res.status(error.statusCode).json({
      ...error.toJSON(),
      requestId,
    });
  }
};
