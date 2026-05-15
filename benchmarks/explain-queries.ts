import 'dotenv/config';
import prisma from '../lib/prisma.js';

const run = async () => {
  const user = await prisma.user.findFirst({
    where: { email: 'benchuser0@example.com' },
  });

  if (!user) {
    console.error('No seed data found. Run `pnpm bench:seed` first.');
    process.exit(1);
  }

  const todo = await prisma.todo.findFirst({
    where: { userId: user.id },
  });

  if (!todo) {
    console.error('No seed data found. Run `pnpm bench:seed` first.');
    process.exit(1);
  }

  const queries = [
    {
      name: 'findByUser (list todos)',
      fn: () =>
        prisma.$queryRaw`EXPLAIN ANALYZE SELECT * FROM todos WHERE user_id = ${user.id} ORDER BY created_at DESC`,
    },
    {
      name: 'findOne (single todo)',
      fn: () =>
        prisma.$queryRaw`EXPLAIN ANALYZE SELECT * FROM todos WHERE id = ${todo.id} AND user_id = ${user.id} LIMIT 1`,
    },
    {
      name: 'findByEmail (login)',
      fn: () =>
        prisma.$queryRaw`EXPLAIN ANALYZE SELECT * FROM users WHERE email = ${user.email} LIMIT 1`,
    },
  ];

  for (const q of queries) {
    console.log(`\n=== ${q.name} ===`);
    const rows = (await q.fn()) as { 'QUERY PLAN': string }[];
    for (const row of rows) {
      console.log(row['QUERY PLAN']);
    }
  }
  await prisma.$disconnect();
};

run().catch((err) => {
  console.error('EXPLAIN ANALYZE failed:', err);
  process.exit(1);
});
