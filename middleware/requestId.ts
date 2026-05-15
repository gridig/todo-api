import type { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger.js';
import type { RequestWithLogger } from '../types/index.js';

/**
 * Extract request ID from headers, handling string or string[] types
 */
const getHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return undefined;
};

export const requestIdMiddleware = (
  req: RequestWithLogger,
  res: Response,
  next: NextFunction
): void => {
  const incomingCorrelationId = getHeaderValue(req.headers['x-correlation-id']);

  // Check for existing correlation ID from upstream services
  req.id =
    getHeaderValue(req.headers['x-request-id']) ||
    incomingCorrelationId ||
    uuidv4();

  // Echo both tracing headers so distributed systems can follow the chain
  res.setHeader('X-Request-ID', req.id);
  if (incomingCorrelationId) {
    res.setHeader('X-Correlation-ID', incomingCorrelationId);
  }

  // Create child logger with request context
  req.log = logger.child({
    requestId: req.id,
    method: req.method,
    path: req.path,
  });

  next();
};
