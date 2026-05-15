import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import {
  BASE_URL,
  BENCH_USER_EMAIL,
  BENCH_USER_PASSWORD,
  LOAD_LEVELS,
  WARMUP_DURATION,
  WARMUP_VUS,
} from './config.js';

/* global __ENV */
const errorRate = new Rate('error_rate');
const loginLatency = new Trend('login_latency', true);
const listTodosLatency = new Trend('list_todos_latency', true);
const createTodoLatency = new Trend('create_todo_latency', true);
const toggleTodoLatency = new Trend('toggle_todo_latency', true);
const deleteTodoLatency = new Trend('delete_todo_latency', true);

const LEVEL = __ENV.LOAD_LEVEL || 'medium';
const level = LOAD_LEVELS[LEVEL];

if (!level) {
  throw new Error(
    `Unknown LOAD_LEVEL: ${LEVEL}. Use: low, medium, high, overload`,
  );
}

export const options = {
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: WARMUP_VUS,
      duration: WARMUP_DURATION,
      startTime: '0s',
      tags: { phase: 'warmup' },
    },
    load: {
      executor: 'constant-arrival-rate',
      rate: level.rps,
      timeUnit: '1s',
      duration: level.duration,
      preAllocatedVUs: level.vus,
      maxVUs: level.maxVUs || level.vus * 2,
      startTime: WARMUP_DURATION,
      tags: { phase: 'load' },
    },
  },
  thresholds: level.thresholds,
};

export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: BENCH_USER_EMAIL, password: BENCH_USER_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  loginLatency.add(loginRes.timings.duration);

  if (loginRes.status !== 200) {
    throw new Error(
      `Login failed: ${loginRes.status} ${loginRes.body} (email: ${BENCH_USER_EMAIL})`,
    );
  }

  check(loginRes, { 'login succeeded': (r) => r.status === 200 });

  const token = JSON.parse(loginRes.body).token;
  return { token };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };

  group('List todos', () => {
    const res = http.get(`${BASE_URL}/todos`, { headers });
    listTodosLatency.add(res.timings.duration);
    errorRate.add(res.status !== 200);
    check(res, { 'list 200': (r) => r.status === 200 });
  });

  group('Create + Toggle + Delete todo', () => {
    const createRes = http.post(
      `${BASE_URL}/todos`,
      JSON.stringify({ text: `k6 bench todo ${Date.now()}` }),
      { headers },
    );
    createTodoLatency.add(createRes.timings.duration);
    errorRate.add(createRes.status !== 201);
    check(createRes, { 'create 201': (r) => r.status === 201 });

    if (createRes.status === 201) {
      const todoId = JSON.parse(createRes.body).id;

      const toggleRes = http.patch(`${BASE_URL}/todos/${todoId}`, null, {
        headers,
        tags: { name: 'PATCH /todos/:id' },
      });
      toggleTodoLatency.add(toggleRes.timings.duration);
      errorRate.add(toggleRes.status !== 200);

      const deleteRes = http.del(`${BASE_URL}/todos/${todoId}`, null, {
        headers,
        tags: { name: 'DELETE /todos/:id' },
      });
      deleteTodoLatency.add(deleteRes.timings.duration);
      errorRate.add(deleteRes.status !== 204);
    }
  });
}

export function handleSummary(data) {
  return {
    [`benchmarks/results/application-performance-${LEVEL}.json`]:
      JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
