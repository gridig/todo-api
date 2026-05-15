import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../prisma/generated/prisma/client.js';
import { dbQueryDuration } from '../middleware/metrics.js';
import { env } from '../config/env.js';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  min: env.DB_POOL_MIN,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
});

const adapter = new PrismaPg(pool);

const basePrisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

const prisma = env.DISABLE_DB_METRICS
  ? basePrisma
  : basePrisma.$extends({
      query: {
        $allOperations({ operation, model, args, query }) {
          const end = dbQueryDuration.startTimer({
            operation,
            model: model ?? 'unknown',
          });
          return query(args).finally(() => end());
        },
      },
    });

export { pool };
export default prisma;
