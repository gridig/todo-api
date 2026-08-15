import { jest } from '@jest/globals';
import {
  ResendMailer,
  LogMailer,
  createMailer,
  verificationUrl,
  buildVerificationUrl,
  emailChangeUrl,
  buildEmailChangeUrl,
} from '@/lib/mailer.js';

const okResponse = () => new Response('{"id":"x"}', { status: 200 });

describe('ResendMailer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the verification link to the Resend API with bearer auth', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    await mailer.sendVerificationEmail({
      to: 'user@example.com',
      verifyUrl: 'https://app.example.com/verify-email?token=abc',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Typed structurally rather than as RequestInit: the DOM lib global is not
    // in scope for this project's lint config.
    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers!.Authorization).toBe('Bearer re_secret');

    const body = JSON.parse(init.body!) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(body.from).toBe('Todo <no-reply@example.com>');
    expect(body.to).toEqual(['user@example.com']);
    expect(body.text).toContain('https://app.example.com/verify-email?token=abc');
  });

  it('throws when the provider rejects the send', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('domain not verified', { status: 422 }));
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    await expect(
      mailer.sendVerificationEmail({ to: 'user@example.com', verifyUrl: 'https://x/y' }),
    ).rejects.toThrow(/HTTP 422/);
  });

  it('does not put the recipient address in the error it throws', async () => {
    // The address is the PII this whole flow protects; a send failure is logged
    // and counted, so anything it carries lands in the logs.
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    const err = await mailer
      .sendVerificationEmail({ to: 'secret-user@example.com', verifyUrl: 'https://x/y' })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain('secret-user@example.com');
  });

  it('posts the email-change confirmation to the new address', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    await mailer.sendEmailChangeVerification({
      to: 'new@example.com',
      verifyUrl: 'https://app.example.com/verify-email-change?token=abc',
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body!) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(['new@example.com']);
    expect(body.subject).toMatch(/new email address/i);
    expect(body.text).toContain('https://app.example.com/verify-email-change?token=abc');
    // Until it is confirmed, nothing has moved — the mail must say so.
    expect(body.text).toMatch(/keeps its current address/i);
  });

  it('notifies the old address, naming the address the account moved to', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    await mailer.sendEmailChangedNotice({ to: 'old@example.com', newEmail: 'new@example.com' });

    const [, init] = fetchSpy.mock.calls[0] as [string, { body?: string }];
    const body = JSON.parse(init.body!) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(['old@example.com']);
    expect(body.subject).toMatch(/changed/i);
    expect(body.text).toContain('new@example.com');
    // This mail is the takeover tripwire, so it has to tell the reader what to do.
    expect(body.text).toMatch(/contact support/i);
  });

  it('names the failing message kind without leaking the recipient', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    const err = await mailer
      .sendEmailChangedNotice({ to: 'old-secret@example.com', newEmail: 'new-secret@example.com' })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err!.message).toMatch(/email-change notice/);
    expect(err!.message).not.toContain('old-secret@example.com');
    expect(err!.message).not.toContain('new-secret@example.com');
  });

  it('truncates a hostile or verbose provider response', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('z'.repeat(5000), { status: 400 }));
    const mailer = new ResendMailer('re_secret', 'Todo <no-reply@example.com>');

    const err = await mailer
      .sendVerificationEmail({ to: 'user@example.com', verifyUrl: 'https://x/y' })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message.length).toBeLessThan(300);
  });
});

describe('LogMailer', () => {
  it('resolves without sending anything', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const logMailer = new LogMailer();

    await expect(
      logMailer.sendVerificationEmail({ to: 'user@example.com', verifyUrl: 'https://x/y' }),
    ).resolves.toBeUndefined();
    await expect(
      logMailer.sendEmailChangeVerification({ to: 'user@example.com', verifyUrl: 'https://x/y' }),
    ).resolves.toBeUndefined();
    await expect(
      logMailer.sendEmailChangedNotice({ to: 'old@example.com', newEmail: 'new@example.com' }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('createMailer', () => {
  it('falls back to the log transport when mail is not configured', () => {
    // The test env sets no RESEND_API_KEY; production is prevented from
    // reaching this branch by assertProductionEnv.
    expect(createMailer()).toBeInstanceOf(LogMailer);
  });
});

describe('verificationUrl', () => {
  it('builds a link against the configured APP_BASE_URL', () => {
    expect(verificationUrl('tok')).toMatch(/\/verify-email\?token=tok$/);
  });

  it('percent-encodes the token', () => {
    // base64url never produces these, but the link is user-facing and the
    // encoding is what keeps a future token alphabet from breaking the query.
    expect(buildVerificationUrl('https://app.example.com', 'a+b/c=')).toContain(
      'token=a%2Bb%2Fc%3D',
    );
  });

  it.each(['https://app.example.com/', 'https://app.example.com///'])(
    'collapses a trailing slash on the base URL (%s)',
    (base) => {
      expect(buildVerificationUrl(base, 'tok')).toBe(
        'https://app.example.com/verify-email?token=tok',
      );
    },
  );
});

describe('emailChangeUrl', () => {
  it('uses a distinct path from the signup link', () => {
    // The two tokens live in different tables; a change token sent to the signup
    // path would just fail, so the server must never build that link.
    expect(emailChangeUrl('tok')).toMatch(/\/verify-email-change\?token=tok$/);
    expect(verificationUrl('tok')).not.toContain('verify-email-change');
  });

  it('percent-encodes the token and collapses trailing slashes', () => {
    expect(buildEmailChangeUrl('https://app.example.com//', 'a+b')).toBe(
      'https://app.example.com/verify-email-change?token=a%2Bb',
    );
  });
});
