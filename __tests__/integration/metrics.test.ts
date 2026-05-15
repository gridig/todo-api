import request from 'supertest';
import {
  createTestApp,
  connectTestDB,
  disconnectTestDB,
} from '../helpers/testSetup.js';
import { register } from '../../middleware/metrics.js';

const app = createTestApp();

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
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(
        /text\/plain|application\/openmetrics-text/,
      );
      expect(response.text).toContain('http_request_duration_seconds');
      expect(response.text).toContain('http_requests_total');
      expect(response.text).toContain('rate_limit_hits_total');
      expect(response.text).toContain('db_query_duration_seconds');
      expect(response.text).toContain('active_connections');
    });

    it('should include default Node.js metrics', async () => {
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('process_cpu_');
      expect(response.text).toContain('nodejs_heap_size_total_bytes');
      expect(response.text).toContain('nodejs_eventloop_lag_');
    });

    it('should not be rate limited', async () => {
      // Fire multiple requests rapidly - should all succeed
      const requests = Array.from({ length: 10 }, () =>
        request(app).get('/metrics'),
      );
      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
      });
    });

    it('should track request metrics after making requests', async () => {
      // Make a health check request to generate metrics
      await request(app).get('/health');

      const response = await request(app).get('/metrics');

      expect(response.text).toMatch(
        /http_requests_total\{[^}]*method="GET"[^}]*route="\/health"[^}]*\}\s+\d+/,
      );
    });
  });
});
