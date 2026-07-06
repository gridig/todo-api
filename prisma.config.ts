import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // || not ??: an explicitly-empty DATABASE_MIGRATE_URL must fall back too.
    url: process.env.DATABASE_MIGRATE_URL || process.env.DATABASE_URL || '',
  },
});
