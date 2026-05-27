import { jest } from '@jest/globals';
import { parseOrigins, createOriginValidator } from '../../../middleware/cors.js';

describe('parseOrigins', () => {
  it('returns "*" when the input is the wildcard', () => {
    expect(parseOrigins('*')).toBe('*');
  });

  it('returns "*" when the wildcard has surrounding whitespace', () => {
    expect(parseOrigins('  *  ')).toBe('*');
  });

  it('splits a comma-separated list into trimmed origins', () => {
    expect(parseOrigins('http://a.com, http://b.com ,http://c.com')).toEqual([
      'http://a.com',
      'http://b.com',
      'http://c.com',
    ]);
  });

  it('returns a single-element array for a single origin', () => {
    expect(parseOrigins('http://only.com')).toEqual(['http://only.com']);
  });

  it('filters empty entries from comma-separated lists', () => {
    expect(parseOrigins('http://a.com,,http://b.com')).toEqual(['http://a.com', 'http://b.com']);
  });

  it('throws when the wildcard is mixed with an explicit list', () => {
    expect(() => parseOrigins('*,http://b.com')).toThrow(/CORS_ORIGIN cannot mix the wildcard/);
    expect(() => parseOrigins('http://a.com,*')).toThrow(/CORS_ORIGIN cannot mix the wildcard/);
    expect(() => parseOrigins('http://a.com, * ,http://b.com')).toThrow(
      /CORS_ORIGIN cannot mix the wildcard/,
    );
  });
});

describe('createOriginValidator', () => {
  it('returns undefined (cors-allow-all) when the wildcard is configured', () => {
    expect(createOriginValidator('*', true)).toBeUndefined();
    expect(createOriginValidator('*', false)).toBeUndefined();
  });

  describe('allowlist mode', () => {
    const validator = createOriginValidator(['http://a.com', 'http://b.com'], true);

    it('allows a request whose origin is in the allowlist', () => {
      const callback = jest.fn();
      // validator is non-undefined because we passed an array, not '*'.
      // The cast narrows the type for the function call.
      (validator as (origin: string | undefined, cb: typeof callback) => void)(
        'http://a.com',
        callback,
      );
      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it('rejects a request whose origin is NOT in the allowlist', () => {
      const callback = jest.fn();
      (validator as (origin: string | undefined, cb: typeof callback) => void)(
        'http://evil.com',
        callback,
      );
      expect(callback).toHaveBeenCalledWith(expect.any(Error), false);
      const errArg = callback.mock.calls[0]?.[0] as Error;
      expect(errArg.message).toMatch(/not allowed by CORS policy/);
    });
  });

  describe('no-origin handling', () => {
    it('allows missing Origin header when allowNoOrigin=true', () => {
      const validator = createOriginValidator(['http://a.com'], true);
      const callback = jest.fn();
      (validator as (origin: string | undefined, cb: typeof callback) => void)(undefined, callback);
      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it('rejects missing Origin header when allowNoOrigin=false', () => {
      const validator = createOriginValidator(['http://a.com'], false);
      const callback = jest.fn();
      (validator as (origin: string | undefined, cb: typeof callback) => void)(undefined, callback);
      expect(callback).toHaveBeenCalledWith(expect.any(Error), false);
      const errArg = callback.mock.calls[0]?.[0] as Error;
      expect(errArg.message).toMatch(/Requests without an Origin header/);
    });
  });
});
