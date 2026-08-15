import { parseArgs } from '../../../scripts/verify-email.js';

describe('verify-email parseArgs', () => {
  it('defaults to dryRun=false with just an email', () => {
    expect(parseArgs(['alice@example.com'])).toEqual({
      email: 'alice@example.com',
      dryRun: false,
    });
  });

  it('accepts --dry-run', () => {
    expect(parseArgs(['bob@example.com', '--dry-run'])).toEqual({
      email: 'bob@example.com',
      dryRun: true,
    });
  });

  it('is order-independent for the flag and email', () => {
    expect(parseArgs(['--dry-run', 'c@example.com'])).toEqual({
      email: 'c@example.com',
      dryRun: true,
    });
  });

  it('requires an email', () => {
    expect(() => parseArgs([])).toThrow(/email is required/);
    expect(() => parseArgs(['--dry-run'])).toThrow(/email is required/);
  });

  it('rejects unknown flags and extra positional args', () => {
    expect(() => parseArgs(['a@example.com', '--force'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['a@example.com', 'b@example.com'])).toThrow(
      /unexpected extra argument/,
    );
  });
});
