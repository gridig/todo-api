import { parseArgs } from '../../../scripts/promote-admin.js';

describe('promote-admin parseArgs', () => {
  it('defaults to role=admin, force=false with just an email', () => {
    expect(parseArgs(['alice@example.com'])).toEqual({
      email: 'alice@example.com',
      role: 'admin',
      force: false,
    });
  });

  it('accepts an explicit --role', () => {
    expect(parseArgs(['bob@example.com', '--role=user'])).toEqual({
      email: 'bob@example.com',
      role: 'user',
      force: false,
    });
  });

  it('accepts --force in any position', () => {
    expect(parseArgs(['--force', 'c@example.com', '--role=user'])).toEqual({
      email: 'c@example.com',
      role: 'user',
      force: true,
    });
  });

  it('is order-independent for the flags and email', () => {
    expect(parseArgs(['--role=admin', 'c@example.com'])).toEqual({
      email: 'c@example.com',
      role: 'admin',
      force: false,
    });
  });

  it('requires an email', () => {
    expect(() => parseArgs([])).toThrow(/email is required/);
    expect(() => parseArgs(['--role=admin'])).toThrow(/email is required/);
    expect(() => parseArgs(['--force'])).toThrow(/email is required/);
  });

  it('rejects an invalid role', () => {
    expect(() => parseArgs(['a@example.com', '--role=root'])).toThrow(/--role must be one of/);
  });

  it('rejects unknown flags and extra positional args', () => {
    expect(() => parseArgs(['a@example.com', '--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['a@example.com', 'b@example.com'])).toThrow(
      /unexpected extra argument/,
    );
  });
});
