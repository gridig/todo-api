import cors from 'cors';
import { env } from '../config/env.js';
import type { CorsOptions } from 'cors';

/**
 * Parse comma-separated origin string into array
 * Returns '*' if origin is set to wildcard
 *
 * Rejects mixed wildcard+list (e.g. "*,https://app.example.com") at parse time
 * — the validator below treats array entries by `.includes(origin)`, so a
 * literal '*' entry never matches any real origin and silently breaks CORS
 * for every operator-allowed client.
 */
export const parseOrigins = (originString: string): string | string[] => {
  const trimmed = originString.trim();
  if (trimmed === '*') {
    return '*';
  }
  const entries = trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (entries.includes('*')) {
    throw new Error(
      'CORS_ORIGIN cannot mix the wildcard "*" with an explicit list — use one or the other',
    );
  }
  return entries;
};

/**
 * Create CORS origin validation function
 * Returns a function that determines if a given origin is allowed
 */

type OriginCallback = (err: Error | null, origin?: boolean) => void;

export const createOriginValidator = (
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
