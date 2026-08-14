import pino from 'pino';
import { REDACT_PATHS } from '@/middleware/logger.js';

// Exercises the production redact config exactly the way errorHandler uses it:
// log.error({ body: req.body, ... }). Pino wildcards match one path segment
// and leaf names must match exactly, so a new credential-bearing field name
// (e.g. `currentPassword`) silently leaks unless REDACT_PATHS lists it. Every
// such field accepted by a schema in middleware/validation.ts must appear in
// `sensitiveFields` below.
describe('logger redaction', () => {
  const capture = (): { logger: pino.Logger; lines: string[] } => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (line: string) => lines.push(line) },
    );
    return { logger, lines };
  };

  // field name → marker value; one entry per credential/PII body field
  // accepted by any request schema.
  const sensitiveFields: Record<string, string> = {
    password: 'marker-password-x7',
    currentPassword: 'marker-current-password-x7',
    newPassword: 'marker-new-password-x7',
    refreshToken: 'marker-refresh-token-x7',
    token: 'marker-token-x7',
    email: 'marker-email-x7@example.com',
  };

  it.each(Object.entries(sensitiveFields))(
    'redacts body.%s the way errorHandler logs request bodies',
    (field, secret) => {
      const { logger, lines } = capture();
      logger.error({ body: { [field]: secret } }, 'request failed');
      const out = lines.join('');
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED]');
    },
  );

  it('redacts every sensitive field at top level', () => {
    const { logger, lines } = capture();
    logger.error({ ...sensitiveFields }, 'request failed');
    const out = lines.join('');
    for (const secret of Object.values(sensitiveFields)) {
      expect(out).not.toContain(secret);
    }
  });

  it('redacts authorization and cookie headers on serialized requests', () => {
    const { logger, lines } = capture();
    logger.error(
      {
        req: {
          headers: {
            authorization: 'Bearer marker-jwt-x7',
            cookie: 'session=marker-cookie-x7',
          },
        },
      },
      'request failed',
    );
    const out = lines.join('');
    expect(out).not.toContain('marker-jwt-x7');
    expect(out).not.toContain('marker-cookie-x7');
  });
});
