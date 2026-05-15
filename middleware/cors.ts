import cors from 'cors';
import { env } from '../config/env.js';
import type { CorsOptions } from 'cors';

/**
 * Parse comma-separated origin string into array
 * Returns '*' if origin is set to wildcard
 */
const parseOrigins = (originString: string): string | string[] => {
  if (originString.trim() === '*') {
    return '*';
  }
  return originString.split(',').map((origin) => origin.trim());
};

/**
 * Create CORS origin validation function
 * Returns a function that determines if a given origin is allowed
 */

type OriginCallback = (err: Error | null, origin?: boolean) => void;

const createOriginValidator = (
  allowedOrigins: string | string[],
  allowNoOrigin: boolean,
): CorsOptions['origin'] => {
  if (allowedOrigins === '*') {
    return undefined; // Allow all origins
  }

  return (origin: string | undefined, callback: OriginCallback): void => {
    if (!origin) {
      if (allowNoOrigin) {
        callback(null, true);
      } else {
        callback(new Error('Requests without an Origin header are not allowed'), false);
      }
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS policy`), false);
    }
  };
};

/**
 * CORS middleware configuration
 *
 * Features:
 * - Validates origins against allowed list
 * - Handles credentials based on environment configuration
 * - Sets appropriate methods, headers, and max-age
 * - Logs origin validation (via error handler)
 *
 * Note: Preflight OPTIONS requests are automatically handled by the cors package
 */
export const corsMiddleware = cors({
  origin: createOriginValidator(
    parseOrigins(env.CORS_ORIGIN),
    env.CORS_ALLOW_NO_ORIGIN,
  ),
  credentials: env.CORS_CREDENTIALS === 'true',
  methods: env.CORS_METHODS.split(',').map((method) => method.trim()),
  allowedHeaders: env.CORS_HEADERS.split(',').map((header) => header.trim()),
  maxAge: parseInt(env.CORS_MAX_AGE, 10),
  optionsSuccessStatus: 204, // Some legacy browsers (IE11) choke on 204
});
