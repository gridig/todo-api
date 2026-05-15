import express, { Application, Response } from 'express';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import todoRoutes from './routes/todos.js';
import { globalLimiter } from './middleware/rateLimiter.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { corsMiddleware } from './middleware/cors.js';
import { RouteNotFoundError } from './errors/index.js';
import healthRoutes from './routes/health.js';
import type { RequestWithLogger } from './types/index.js';
import { metricsHandler, metricsAuthMiddleware, metricsMiddleware } from './middleware/metrics.js';
import echoRoutes from './routes/echo.js';
import { env } from './config/env.js';

// Create and configure the Express app without starting the server
export const createApp = (): Application => {
  const app: Application = express();

  // Trust the first proxy hop (ALB / ingress). Required for req.ip to reflect
  // the real client IP rather than the proxy — without this, rate limiters
  // count all traffic against the proxy IP and audit log sourceIp is wrong.
  app.set('trust proxy', 1);

  // Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc.).
  // HSTS only takes effect over HTTPS, so it is a no-op locally.
  app.use(helmet());

  // IMPORTANT: Request ID middleware MUST be first after security headers
  // This creates req.id and req.log for all subsequent middleware
  app.use(requestIdMiddleware);

  // Metrics instrumentation (starts the request timer)
  app.use(metricsMiddleware);

  // Echo routes — disabled in production (benchmark tool that bypasses
  // logging, rate limiting, and JSON parsing)
  if (env.NODE_ENV !== 'production') {
    app.use('/echo', echoRoutes);
  }

  // Log all incoming requests with response times
  app.use(requestLoggerMiddleware);

  // CORS middleware - apply BEFORE health routes to allow external health checks
  app.use(corsMiddleware);

  // Health check routes - BEFORE the global rate limiter
  // Liveness (/) is unlimited; readiness (/ready) has its own dedicated limiter
  app.use('/health', healthRoutes);

  // Metrics endpoint (before rate limiting, exempt from global limiter)
  // Protected by optional METRICS_TOKEN bearer auth — strongly recommended in production
  app.get('/metrics', metricsAuthMiddleware, metricsHandler);

  // Apply middleware
  app.use(globalLimiter);
  app.use(express.json({ limit: env.BODY_LIMIT }));

  // Apply routes
  app.use('/auth', authRoutes);
  app.use('/todos', todoRoutes);

  // 404 handler - catches routes that don't exist
  app.use((req: RequestWithLogger, res: Response) => {
    const { log, id: requestId } = req;
    log.warn({ path: req.path, method: req.method }, 'Route not found');
    const error = new RouteNotFoundError(req.path);
    res.status(error.statusCode).json({
      ...error.toJSON(),
      requestId,
    });
  });

  // This catches all errors thrown in routes and middleware
  app.use(errorHandler);

  return app;
};

// Export a default app instance for convenience
const app: Application = createApp();
export default app;
