import crypto from 'crypto';
import jwt, { type SignOptions, type VerifyOptions, type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { JWTPayload } from '../types/index.js';

const REFRESH_TOKEN_BYTES = 32;
const VERIFICATION_TOKEN_BYTES = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

// Candidate verify secrets, current first. JWT_SECRET_PREVIOUS is present only
// during a rotation window so tokens signed before the cutover keep verifying
// until they expire; signing always uses JWT_SECRET alone.
export function accessTokenSecrets(): string[] {
  return env.JWT_SECRET_PREVIOUS ? [env.JWT_SECRET, env.JWT_SECRET_PREVIOUS] : [env.JWT_SECRET];
}

// Single source of truth for the access-token shape. Payload carries the RFC
// 7519 `sub` claim (user id); `iss`/`aud` are enforced unconditionally by
// middleware/auth.ts, HS256, expiry from ACCESS_TOKEN_EXPIRY. Extracted from
// the inline jwt.sign calls that used to live in routes/auth.ts so register,
// login, and refresh all issue identical tokens.
export function signAccessToken(userId: string): string {
  const payload: JWTPayload = { sub: userId };
  const options: SignOptions = {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    // ACCESS_TOKEN_EXPIRY is validated as a plain non-empty string; jsonwebtoken's
    // types want the ms-branded StringValue, so widen through the option type
    // (NonNullable to satisfy exactOptionalPropertyTypes — it's never undefined).
    expiresIn: env.ACCESS_TOKEN_EXPIRY as NonNullable<SignOptions['expiresIn']>,
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

// Verify an access token against the candidate secrets (current, then the
// rotation-window previous secret if set), enforcing HS256 + iss/aud with a 5s
// clock tolerance. Returns the decoded payload, or throws the last verification
// error when no secret validates — the caller (middleware/auth.ts) maps that to
// a 401 and audits the reason.
export function verifyAccessToken(
  token: string,
  secrets: string[] = accessTokenSecrets(),
): JwtPayload | string {
  const options: VerifyOptions = {
    algorithms: ['HS256'],
    clockTolerance: 5,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  };
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret, options);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('token verification failed');
}

// SHA-256 hex of a raw refresh token. Refresh tokens are 256-bit random
// strings, so an unkeyed hash is sufficient — there is nothing to brute-force.
// Exported so the verify path can hash an incoming token and look it up by the
// stored hash.
export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Generate an opaque refresh token: 256 bits of entropy, base64url so it is
// URL/JSON-safe. Returns the raw token (handed to the client exactly once) and
// its hash (the only value ever persisted — a DB leak can't be replayed).
export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}

// Absolute expiry for a freshly issued refresh token, REFRESH_TOKEN_EXPIRY_DAYS
// from `from`. Passed explicitly so callers inside a transaction can pin a
// single timestamp across the rotate (revoke-old + issue-new) pair.
export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.REFRESH_TOKEN_EXPIRY_DAYS * MS_PER_DAY);
}

// Email-verification tokens use the same construction as refresh tokens — 256
// bits of entropy, unkeyed SHA-256 at rest — because they carry the same
// property: a high-entropy bearer secret with nothing to brute-force. They are
// deliberately NOT refresh tokens: shorter lived, single use, and redeeming one
// grants no session.
export function hashVerificationToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateVerificationToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashVerificationToken(raw) };
}

export function verificationTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + env.VERIFICATION_TOKEN_EXPIRY_HOURS * MS_PER_HOUR);
}
