import type { Response, NextFunction } from 'express';
import { requestContext, type RequestContext } from '../lib/requestContext.js';
import type { RequestWithLogger } from '../types/index.js';

export function requestContextMiddleware(
  req: RequestWithLogger,
  _res: Response,
  next: NextFunction,
): void {
  const userAgent = req.header('User-Agent');
  const store: RequestContext = {
    requestId: req.id,
    ...(req.ip !== undefined && { ip: req.ip }),
    ...(userAgent !== undefined && { userAgent }),
  };
  requestContext.run(store, () => next());
}
