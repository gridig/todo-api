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

// Accept tracing IDs only when they match a safe shape. Node's setHeader
// already blocks CRLF at runtime, but req.id flows into every log line and
// into log-aggregator UIs that may render it unsafely (stored-XSS-via-log).
// Reject anything that isn't an opaque token; fall back to a fresh UUID.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const sanitizeRequestId = (value: string | undefined): string | undefined =>
  value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : undefined;

export const requestIdMiddleware = (
  req: RequestWithLogger,
  res: Response,
  next: NextFunction
): void => {
  const incomingCorrelationId = sanitizeRequestId(
    getHeaderValue(req.headers['x-correlation-id']),
  );

  // Check for existing correlation ID from upstream services
  req.id =
    sanitizeRequestId(getHeaderValue(req.headers['x-request-id'])) ||
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
