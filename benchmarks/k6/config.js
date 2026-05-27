/* global __ENV */
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const BENCH_USER_EMAIL = __ENV.BENCH_USER_EMAIL || 'benchuser0@example.com';
export const BENCH_USER_PASSWORD = __ENV.BENCH_USER_PASSWORD || 'BenchPass1!';

export const WARMUP_DURATION = '30s';
export const WARMUP_VUS = 10;

export const LOAD_LEVELS = {
  low: {
    vus: 10,
    duration: '60s',
    rps: 10,
    thresholds: {
      'http_req_duration{phase:load}': ['p(50)<250', 'p(95)<400', 'p(99)<700'],
      'http_req_failed{phase:load}': ['rate<0.01'],
    },
  },
  medium: {
    vus: 100,
    maxVUs: 300,
    duration: '60s',
    rps: 300,
    thresholds: {
      'http_req_duration{phase:load}': ['p(50)<300', 'p(95)<700', 'p(99)<1200'],
      'http_req_failed{phase:load}': ['rate<0.01'],
    },
  },
  high: {
    vus: 500,
    maxVUs: 1200,
    duration: '60s',
    rps: 1000,
    thresholds: {
      'http_req_duration{phase:load}': ['p(50)<200', 'p(95)<1000', 'p(99)<2000'],
      'http_req_failed{phase:load}': ['rate<0.05'],
    },
  },
  overload: {
    vus: 1500,
    maxVUs: 4000,
    duration: '60s',
    rps: 3000,
    thresholds: {},
  },
};
