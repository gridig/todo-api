import { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      userId?: string;
    }

    interface Response {
      _loggerWrapped?: boolean;
    }
  }
}

export {};
