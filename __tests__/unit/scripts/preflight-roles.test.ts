import { jest } from '@jest/globals';
import { runPreflight, type PreflightOptions } from '../../../scripts/preflight-roles.js';

const ALL_ROLES = ['db_admin', 'db_app', 'db_auditor'];
const DSN = 'postgresql://db_admin:pw@localhost:5432/todo_api';

type QueryRoles = NonNullable<PreflightOptions['queryRoles']>;

const makeLog = () => ({ log: jest.fn(), error: jest.fn() });
const noSleep = async (): Promise<void> => undefined;

describe('runPreflight', () => {
  it('fails immediately without querying when no connection string is set', async () => {
    const queryRoles = jest.fn<QueryRoles>();
    const log = makeLog();

    const code = await runPreflight({ env: {}, queryRoles, sleep: noSleep, log });

    expect(code).toBe(1);
    expect(queryRoles).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('neither DATABASE_MIGRATE_URL nor DATABASE_URL'),
    );
  });

  it('does not retry the deterministic missing-roles outcome', async () => {
    const queryRoles = jest.fn<QueryRoles>().mockResolvedValue(['db_app']);
    const sleep = jest.fn<(ms: number) => Promise<void>>();
    const log = makeLog();

    const code = await runPreflight({ env: { DATABASE_MIGRATE_URL: DSN }, queryRoles, sleep, log });

    expect(code).toBe(1);
    expect(queryRoles).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('missing required DB role(s): db_admin, db_auditor'),
    );
  });

  it('retries a transient connection failure and succeeds, logging the attempt', async () => {
    const queryRoles = jest
      .fn<QueryRoles>()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce(ALL_ROLES);
    const log = makeLog();

    const code = await runPreflight({
      env: { DATABASE_MIGRATE_URL: DSN },
      queryRoles,
      sleep: noSleep,
      log,
    });

    expect(code).toBe(0);
    expect(queryRoles).toHaveBeenCalledTimes(2);
    // Default DB_CONNECTION_TIMEOUT_MS is forwarded to each attempt.
    expect(queryRoles).toHaveBeenCalledWith(DSN, 5000);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/connection attempt 1\/6 failed .*retrying in \d+ms/),
    );
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('preflight-roles: OK'));
  });

  it('honours DB_CONNECT_MAX_RETRIES and fails after exhausting attempts', async () => {
    const queryRoles = jest.fn<QueryRoles>().mockRejectedValue(new Error('ECONNREFUSED'));
    const log = makeLog();

    const code = await runPreflight({
      env: { DATABASE_MIGRATE_URL: DSN, DB_CONNECT_MAX_RETRIES: '2' },
      queryRoles,
      sleep: noSleep,
      log,
    });

    expect(code).toBe(1);
    expect(queryRoles).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'could not verify DB roles (connection or query failed, 3 attempt(s))',
      ),
      'ECONNREFUSED',
    );
  });

  it('makes a single attempt when DB_CONNECT_MAX_RETRIES=0', async () => {
    const queryRoles = jest.fn<QueryRoles>().mockRejectedValue(new Error('boom'));
    const sleep = jest.fn<(ms: number) => Promise<void>>();
    const log = makeLog();

    const code = await runPreflight({
      env: { DATABASE_MIGRATE_URL: DSN, DB_CONNECT_MAX_RETRIES: '0' },
      queryRoles,
      sleep,
      log,
    });

    expect(code).toBe(1);
    expect(queryRoles).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('falls back to defaults on unparseable knobs instead of crashing', async () => {
    const queryRoles = jest.fn<QueryRoles>().mockResolvedValue(ALL_ROLES);
    const log = makeLog();

    const code = await runPreflight({
      env: {
        DATABASE_MIGRATE_URL: DSN,
        DB_CONNECT_MAX_RETRIES: 'abc',
        DB_CONNECTION_TIMEOUT_MS: '-5',
      },
      queryRoles,
      sleep: noSleep,
      log,
    });

    expect(code).toBe(0);
    expect(queryRoles).toHaveBeenCalledWith(DSN, 5000);
  });
});
