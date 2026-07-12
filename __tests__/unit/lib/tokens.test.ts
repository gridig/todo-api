import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
} from '@/lib/tokens.js';

const PREV_SECRET = 'previous-rotation-secret-at-least-32-chars-long';

// Sign a token with an explicit secret, mirroring production claims (iss/aud)
// so verifyAccessToken's claim checks pass.
function signWith(secret: string, sub = 'user-1', overrides: jwt.SignOptions = {}): string {
  return jwt.sign({ sub }, secret, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: '15m',
    ...overrides,
  });
}

describe('signAccessToken', () => {
  it('signs an HS256 token carrying sub/iss/aud and an expiry', () => {
    const token = signAccessToken('user-123');
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as jwt.JwtPayload;

    expect(decoded.sub).toBe('user-123');
    expect(decoded.iss).toBe(env.JWT_ISSUER);
    expect(decoded.aud).toBe(env.JWT_AUDIENCE);
    expect(typeof decoded.exp).toBe('number');
    expect(typeof decoded.iat).toBe('number');
  });
});

describe('verifyAccessToken', () => {
  it('verifies a token signed with the current secret', () => {
    const token = signAccessToken('user-42');
    const decoded = verifyAccessToken(token) as jwt.JwtPayload;
    expect(decoded.sub).toBe('user-42');
  });

  it('accepts a token signed with the previous secret during a rotation window', () => {
    // Simulate the dual-secret window: current secret is env.JWT_SECRET, the
    // previous is passed as the second candidate.
    const token = signWith(PREV_SECRET, 'user-7');
    const decoded = verifyAccessToken(token, [env.JWT_SECRET, PREV_SECRET]) as jwt.JwtPayload;
    expect(decoded.sub).toBe('user-7');
  });

  it('rejects a token signed with an unknown secret', () => {
    const token = signWith('some-other-unrelated-secret-32-characters-x');
    expect(() => verifyAccessToken(token, [env.JWT_SECRET, PREV_SECRET])).toThrow();
  });

  it('rejects an expired token even under the current secret', () => {
    const token = signAccessToken('user-1');
    // Past the 5s clockTolerance in verifyAccessToken.
    const expired = signWith(env.JWT_SECRET, 'user-1', { expiresIn: '-60s' });
    expect(() => verifyAccessToken(expired)).toThrow();
    // sanity: the fresh one still verifies
    expect(() => verifyAccessToken(token)).not.toThrow();
  });

  it('rejects a token with the wrong audience', () => {
    const token = jwt.sign({ sub: 'user-1' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: env.JWT_ISSUER,
      audience: 'some-other-audience',
      expiresIn: '15m',
    });
    expect(() => verifyAccessToken(token)).toThrow();
  });
});

describe('generateRefreshToken / hashRefreshToken', () => {
  it('produces a base64url raw token and its matching sha256 hash', () => {
    const { raw, hash } = generateRefreshToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
    expect(hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(hash).toHaveLength(64);
  });

  it('generates unique tokens across calls', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashRefreshToken is deterministic for the same input', () => {
    expect(hashRefreshToken('some-raw-token')).toBe(hashRefreshToken('some-raw-token'));
  });
});

describe('refreshTokenExpiry', () => {
  it('is REFRESH_TOKEN_EXPIRY_DAYS in the future from the given anchor', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const exp = refreshTokenExpiry(from);
    const days = (exp.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(env.REFRESH_TOKEN_EXPIRY_DAYS);
  });
});
