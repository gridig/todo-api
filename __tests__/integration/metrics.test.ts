import request from 'supertest';
import { createTestApp, connectTestDB, disconnectTestDB } from '../helpers/testSetup.js';
import { register } from '@/middleware/metrics.js';
import { env } from '@/config/env.js';

const app = createTestApp();
const bearer = `Bearer ${env.METRICS_TOKEN}`;

describe('Metrics Endpoint', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(() => {
    register.resetMetrics();
  });

  describe('GET /metrics', () => {
    it('should return 200 with Prometheus text format', async () => {
      const response = await request(app).get('/metrics').set('Authorization', bearer);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/plain|application\/openmetrics-text/);
      expect(response.text).toContain('http_request_duration_seconds');
      expect(response.text).toContain('http_requests_total');
      expect(response.text).toContain('rate_limit_hits_total');
      expect(response.text).toContain('db_query_duration_seconds');
      expect(response.text).toContain('active_connections');
    });

    it('should not include default Node.js metrics under NODE_ENV=test', async () => {
      // `collectDefaultMetrics({ register })` is gated on `env.NODE_ENV !== 'test'`
      // in `middleware/metrics.ts` to prevent prom-client's setInterval samplers
      // from firing after Jest tears down the VM. The metrics are emitted normally
      // in development and production.
      const response = await request(app).get('/metrics').set('Authorization', bearer);

      expect(response.text).not.toContain('process_cpu_');
      expect(response.text).not.toContain('nodejs_heap_size_total_bytes');
      expect(response.text).not.toContain('nodejs_eventloop_lag_');
    });

    it('should not be rate limited', async () => {
      // Fire multiple requests rapidly - should all succeed
      const requests = Array.from({ length: 10 }, () =>
        request(app).get('/metrics').set('Authorization', bearer),
      );
      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });
    });

    it('should track request metrics after making requests', async () => {
      // Make a health check request to generate metrics
      await request(app).get('/health');

      const response = await request(app).get('/metrics').set('Authorization', bearer);

      expect(response.text).toMatch(
        /http_requests_total\{[^}]*method="GET"[^}]*route="\/health"[^}]*\}\s+\d+/,
      );
    });
  });
});
