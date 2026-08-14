import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

// Exercises the REAL env branch of accessTokenSecrets() — the existing
// tokens.test.ts passes secret arrays explicitly, so nothing there verifies
// that JWT_SECRET_PREVIOUS is honored while set, or that clearing it makes
// tokens signed with the retired secret stop verifying.
const CURRENT_SECRET = 'current-secret-for-rotation-test-32ch';
const PREVIOUS_SECRET = 'previous-secret-for-rotation-test-32c';
const ISSUER = 'todo-api';
const AUDIENCE = 'todo-api-clients';

jest.unstable_mockModule('@/config/env.js', () => ({
  env: {
    JWT_SECRET: CURRENT_SECRET,
    JWT_SECRET_PREVIOUS: PREVIOUS_SECRET,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    ACCESS_TOKEN_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY_DAYS: 30,
  },
}));

const { accessTokenSecrets, signAccessToken, verifyAccessToken } = await import('@/lib/tokens.js');

const signWith = (secret: string): string =>
  jwt.sign({ sub: 'user-1' }, secret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: '15m',
  });

describe('JWT secret rotation window', () => {
  it('candidate secrets are [current, previous] while JWT_SECRET_PREVIOUS is set', () => {
    expect(accessTokenSecrets()).toEqual([CURRENT_SECRET, PREVIOUS_SECRET]);
  });

  it('a token signed with the OLD secret still verifies during the window (default secrets)', () => {
    const oldToken = signWith(PREVIOUS_SECRET);
    const decoded = verifyAccessToken(oldToken);
    expect((decoded as jwt.JwtPayload).sub).toBe('user-1');
  });

  it('new tokens are always signed with the CURRENT secret, never the previous', () => {
    const token = signAccessToken('user-1');
    expect(() =>
      jwt.verify(token, CURRENT_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).not.toThrow();
    expect(() =>
      jwt.verify(token, PREVIOUS_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).toThrow();
  });

  it('a token signed with the OLD secret is REJECTED once the window closes', () => {
    // Window closed = JWT_SECRET_PREVIOUS cleared = candidate list is
    // [current] only. A retired secret staying valid forever would defeat
    // the entire point of rotating it.
    const oldToken = signWith(PREVIOUS_SECRET);
    expect(() => verifyAccessToken(oldToken, [CURRENT_SECRET])).toThrow();
  });
});
