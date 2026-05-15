import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';
import {
  BASE_URL,
  LOAD_LEVELS,
  WARMUP_DURATION,
  WARMUP_VUS,
} from './config.js';

/* global __ENV */
const errorRate = new Rate('error_rate');
const echoLatency = new Trend('echo_latency', true);

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

export default function () {
  const res = http.get(`${BASE_URL}/echo`);

  echoLatency.add(res.timings.duration);
  errorRate.add(res.status !== 200);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has message field': (r) => JSON.parse(r.body).message === 'echo',
  });
}

export function handleSummary(data) {
  return {
    [`benchmarks/results/framework-overhead-${LEVEL}.json`]: JSON.stringify(
      data,
      null,
      2,
    ),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
