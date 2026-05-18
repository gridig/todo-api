import jwt from 'jsonwebtoken';
import { Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { NoTokenError, InvalidTokenError } from '../errors/index.js';
import type { RequestWithLogger } from '../types/index.js';

export const auth = (
  req: RequestWithLogger,
  res: Response,
  next: NextFunction,
): void => {
  const { log, id: requestId } = req;
  try {
    const authHeader = req.header('Authorization');

    if (!authHeader) {
      log.warn(
        {
          path: req.path,
          ip: req.ip,
        },
        'Authentication failed - no token provided',
      );
      const error = new NoTokenError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
      return;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    const token = match?.[1];

    if (!token) {
      log.warn(
        {
          path: req.path,
          ip: req.ip,
        },
        'Authentication failed - empty token',
      );
      const error = new NoTokenError();
      res.status(error.statusCode).json({
        ...error.toJSON(),
        requestId,
      });
      return;
    }

    // The iss/aud check is gated behind JWT_VERIFY_REQUIRE_CLAIMS during the
    // grace window: deploy with the flag false so legacy { userId } tokens
    // issued before the iss/aud rollout still verify; flip to true after a
    // full 24h-expiry cycle so every in-flight token now carries the new
    // claims. 5s clockTolerance absorbs small clock drift across instances.
    const verifyOptions: jwt.VerifyOptions = {
      algorithms: ['HS256'],
      clockTolerance: 5,
      ...(env.JWT_VERIFY_REQUIRE_CLAIMS
        ? { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }
        : {}),
    };
    const decoded = jwt.verify(token, env.JWT_SECRET, verifyOptions);

    if (typeof decoded !== 'object' || decoded === null) {
      throw new Error('Invalid JWT payload');
    }

    // Accept the new RFC-7519 `sub` claim and the legacy `userId` field
    // during the grace window. Reject if neither yields a string.
    const payload = decoded as { sub?: unknown; userId?: unknown };
    const userId =
      typeof payload.sub === 'string'
        ? payload.sub
        : typeof payload.userId === 'string'
          ? payload.userId
          : undefined;
    if (userId === undefined) {
      throw new Error('Invalid JWT payload');
    }

    (req as RequestWithLogger & { userId: string }).userId = userId;

    next();
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : 'Unknown error', // Don't log full error (might contain token)
        path: req.path,
        ip: req.ip,
      },
      'Authentication failed - invalid token',
    );

    const error = new InvalidTokenError();
    res.status(error.statusCode).json({
      ...error.toJSON(),
      requestId,
    });
  }
};
