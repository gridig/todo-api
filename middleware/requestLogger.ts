import type { Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import type { RequestWithLogger } from '../types/index.js';

export const requestLoggerMiddleware = (
  req: RequestWithLogger,
  res: Response,
  next: NextFunction,
): void => {
  // Skip if already wrapped (prevents duplicates)
  if (res._loggerWrapped) {
    next();
    return;
  }
  res._loggerWrapped = true;

  const startTime = Date.now();
  const { log } = req;

  // Only log incoming request in development
  const isDev = env.NODE_ENV !== 'production';
  /* istanbul ignore else */
  if (isDev) {
    log.info({ userAgent: req.get('user-agent') }, 'Incoming request');
  }

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const { statusCode } = res;
    const logFields = {
      statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent'),
    };

    if (statusCode >= 500) {
      log.error(logFields, 'Request completed');
    } else if (statusCode >= 400) {
      log.warn(logFields, 'Request completed');
    } else {
      log.debug(logFields, 'Request completed');
    }
  });

  next();
};
