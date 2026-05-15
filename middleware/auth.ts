import jwt from 'jsonwebtoken';
import { Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { NoTokenError, InvalidTokenError } from '../errors/index.js';
import type { JWTPayload, RequestWithLogger } from '../types/index.js';

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

    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as { userId?: unknown }).userId !== 'string'
    ) {
      throw new Error('Invalid JWT payload');
    }

    const { userId } = decoded as JWTPayload;
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
