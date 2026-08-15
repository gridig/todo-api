import bcrypt from 'bcrypt';

// Defaults to the cost the app actually hashes with (UserService.SALT_ROUNDS =
// 12), so the number reported here is the real per-login cost rather than a
// cheaper synthetic one. Override with BCRYPT_ROUNDS when comparing against an
// implementation pinned to a different cost — the comparison is only meaningful
// when both sides use the same value.
const SALT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);
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
