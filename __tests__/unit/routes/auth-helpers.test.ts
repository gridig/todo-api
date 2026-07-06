import type { Request } from 'express';
import { hashEmail } from '@/routes/auth.js';
import { requireUserId } from '@/middleware/auth.js';
import { normalizeEmail } from '@/models/User.js';
import { createApp } from '@/app.js';
import { env } from '@/config/env.js';
import { InternalServerError } from '@/errors/index.js';

describe('hashEmail', () => {
  it('hashes the canonical (NFC + lowercase + trim) form', () => {
    // é as one codepoint (NFC) vs e + combining acute (NFD) — same account,
    // must produce the same audit hash.
    const nfc = 'josé@example.com';
    const nfd = 'josé@example.com';
    expect(nfc).not.toBe(nfd);
    expect(hashEmail(nfc)).toBe(hashEmail(nfd));
    expect(hashEmail(' JOSÉ@example.com ')).toBe(hashEmail(nfc));
  });

  it('agrees with normalizeEmail canonicalization', () => {
    const variant = ' Useŕ@Example.COM ';
    expect(hashEmail(variant)).toBe(hashEmail(normalizeEmail(variant)));
  });
});

describe('requireUserId', () => {
  it('returns the userId set by the auth middleware', () => {
    const req = { userId: 'user-123' } as unknown as Request;
    expect(requireUserId(req)).toBe('user-123');
  });

  it('throws InternalServerError when auth middleware never ran', () => {
    // A route mounted without `auth` must fail loudly, not silently query
    // with an undefined isolation key.
    expect(() => requireUserId({} as Request)).toThrow(InternalServerError);
    expect(() => requireUserId({ userId: '' } as unknown as Request)).toThrow(InternalServerError);
  });
});

describe('createApp trust proxy', () => {
  it('applies env.TRUST_PROXY to the Express trust proxy setting', () => {
    const app = createApp();
    expect(app.get('trust proxy')).toBe(env.TRUST_PROXY);
  });
});
