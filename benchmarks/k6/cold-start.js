/* global console */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './config.js';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const startTime = Date.now();
  let ready = false;
  let attempts = 0;

  while (!ready && attempts < 60) {
    try {
      const res = http.get(`${BASE_URL}/health/ready`, { timeout: '2s' });
      if (res.status === 200) {
        ready = true;
        const elapsed = Date.now() - startTime;
        console.log(`Cold start: first successful health check after ${elapsed}ms (${attempts + 1} attempts)`);
      }
    } catch {
      // Server not up yet
    }
    attempts++;
    if (!ready) {
      sleep(0.5);
    }
  }

  check(null, { 'server became ready': () => ready });
}
