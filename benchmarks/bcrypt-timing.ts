import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;
const PASSWORD = 'BenchPass1!';
const ITERATIONS = 10;

const run = async () => {
  await bcrypt.hash(PASSWORD, SALT_ROUNDS);

  const times: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const hash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);
    await bcrypt.compare(PASSWORD, hash);
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`bcrypt hash+compare (${ITERATIONS} iterations, ${SALT_ROUNDS} rounds):`);
  console.log(`  avg: ${avg.toFixed(2)}ms`);
  console.log(`  min: ${min.toFixed(2)}ms`);
  console.log(`  max: ${max.toFixed(2)}ms`);
};

run();
