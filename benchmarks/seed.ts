import 'dotenv/config';
import prisma, { pool } from '../lib/prisma.js';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;
const NUM_USERS = 10;
const TODOS_PER_USER = 50;

const seed = async () => {
  console.log('Cleaning existing data...');
  await prisma.todo.deleteMany();
  await prisma.user.deleteMany();

  console.log(`Creating ${NUM_USERS} users with ${TODOS_PER_USER} todos each...`);

  for (let i = 0; i < NUM_USERS; i++) {
    const email = `benchuser${i}@example.com`;
    const hashedPassword = await bcrypt.hash('BenchPass1!', SALT_ROUNDS);

    const user = await prisma.user.create({
      data: { email, password: hashedPassword },
    });

    const todos = Array.from({ length: TODOS_PER_USER }, (_, j) => ({
      text: `Benchmark todo ${j} for user ${i}`,
      done: j % 3 === 0,
      userId: user.id,
    }));

    await prisma.todo.createMany({ data: todos });
    console.log(`  User ${i + 1}/${NUM_USERS}: ${email} (${TODOS_PER_USER} todos)`);
  }

  console.log(`Seeded ${NUM_USERS} users, ${NUM_USERS * TODOS_PER_USER} todos.`);
  await prisma.$disconnect();
  await pool.end();
};

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
