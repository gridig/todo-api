import logger from '../middleware/logger.js';
import { env } from '../config/env.js';

// Outbound mail seam. The app depends on this interface, never on a vendor —
// swapping Resend for SES/SMTP is a new adapter and one line in `createMailer`,
// with no route or model changes. One method per message rather than a generic
// `send(subject, html)`: the copy stays here with the transport, and route
// handlers can't compose mail inline. Adding a message means adding a method,
// which is the point — every message this service can emit is listed here.
export interface Mailer {
  sendVerificationEmail(params: { to: string; verifyUrl: string }): Promise<void>;
  // Sent to the *new* address during an email change — redeeming it is what
  // proves that inbox is reachable before the account moves to it.
  sendEmailChangeVerification(params: { to: string; verifyUrl: string }): Promise<void>;
  // Sent to the *old* address after a change completes. Not a courtesy: it is
  // the only signal the previous owner gets that the account moved, and the only
  // way a takeover via a stolen session is noticed by the person who lost it.
  sendEmailChangedNotice(params: { to: string; newEmail: string }): Promise<void>;
}

const mailLogger = logger.child({ module: 'mailer' });

const SUBJECT = 'Verify your email address';
const CHANGE_SUBJECT = 'Confirm your new email address';
const CHANGED_SUBJECT = 'Your email address was changed';

const bodyText = (verifyUrl: string): string =>
  [
    'Confirm your email address to finish setting up your account:',
    '',
    verifyUrl,
    '',
    `This link expires in ${env.VERIFICATION_TOKEN_EXPIRY_HOURS} hours and can only be used once.`,
    "If you didn't create this account, you can ignore this message.",
  ].join('\n');

const changeBodyText = (verifyUrl: string): string =>
  [
    'Confirm this address so it can become the email on your account:',
    '',
    verifyUrl,
    '',
    `This link expires in ${env.VERIFICATION_TOKEN_EXPIRY_HOURS} hours and can only be used once.`,
    'Until you confirm, your account keeps its current address.',
    "If you didn't request this change, you can ignore this message.",
  ].join('\n');

// The new address is echoed so the recipient can tell a change they made from
// one they didn't. It is the address the account just moved to, which whoever
// made the change already knows.
const changedBodyText = (newEmail: string): string =>
  [
    `The email address on your account was changed to ${newEmail}.`,
    '',
    "If you made this change, nothing further is needed. If you didn't, contact support",
    'immediately — someone else may have access to your account.',
  ].join('\n');

// Implemented against Resend's HTTPS API with fetch rather than the `resend`
// npm package: it is a single POST, and this repo gates dependencies on
// `pnpm audit --prod` and SHA-pinned supply chain review — an SDK for one
// endpoint is surface without benefit. Node 24 has global fetch.
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  private async send(to: string, subject: string, text: string, kind: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [to], subject, text }),
    });

    if (!res.ok) {
      // Body may carry the provider's reason; truncate so a hostile or verbose
      // response can't flood the logs. The address is NOT logged — it is the
      // PII this whole flow exists to protect (see logger redaction).
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Resend rejected the ${kind} email (HTTP ${res.status}): ${detail}`);
    }
  }

  async sendVerificationEmail({ to, verifyUrl }: { to: string; verifyUrl: string }): Promise<void> {
    return this.send(to, SUBJECT, bodyText(verifyUrl), 'verification');
  }

  async sendEmailChangeVerification({
    to,
    verifyUrl,
  }: {
    to: string;
    verifyUrl: string;
  }): Promise<void> {
    return this.send(to, CHANGE_SUBJECT, changeBodyText(verifyUrl), 'email-change verification');
  }

  async sendEmailChangedNotice({ to, newEmail }: { to: string; newEmail: string }): Promise<void> {
    return this.send(to, CHANGED_SUBJECT, changedBodyText(newEmail), 'email-change notice');
  }
}

// Development/CI transport: logs the link instead of sending. Never selected in
// production — assertProductionEnv requires real mail configuration, so a
// misconfigured production deploy fails at boot rather than silently dropping
// every verification email.
export class LogMailer implements Mailer {
  async sendVerificationEmail({ verifyUrl }: { to: string; verifyUrl: string }): Promise<void> {
    mailLogger.info({ verifyUrl }, 'Verification email (log transport — not sent)');
    return Promise.resolve();
  }

  async sendEmailChangeVerification({
    verifyUrl,
  }: {
    to: string;
    verifyUrl: string;
  }): Promise<void> {
    mailLogger.info({ verifyUrl }, 'Email-change verification (log transport — not sent)');
    return Promise.resolve();
  }

  // No address logged: the notice goes to the *old* address, and logging either
  // side of a change would put two linked addresses in the log stream.
  async sendEmailChangedNotice(_params: { to: string; newEmail: string }): Promise<void> {
    mailLogger.info('Email-change notice (log transport — not sent)');
    return Promise.resolve();
  }
}

export function createMailer(): Mailer {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  }
  return new LogMailer();
}

export const mailer: Mailer = createMailer();

// Split from verificationUrl so the joining rules (trailing-slash strip, token
// encoding) are testable without reaching through module-level env.
export function buildVerificationUrl(baseUrl: string, rawToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

// Absolute URL the user clicks. APP_BASE_URL is the public origin of the
// frontend that will POST the token to /auth/verify — the token travels in the
// query string of a link the user opens, which is why it is single-use and
// short-lived.
export function verificationUrl(rawToken: string): string {
  return buildVerificationUrl(env.APP_BASE_URL, rawToken);
}

// Distinct path from the signup link so the frontend routes the token to
// /auth/verify-email-change rather than /auth/verify. Sending a change token to
// the signup endpoint would fail anyway (different tables), but a user should
// never see that error because of a link the server built.
export function buildEmailChangeUrl(baseUrl: string, rawToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/verify-email-change?token=${encodeURIComponent(rawToken)}`;
}

export function emailChangeUrl(rawToken: string): string {
  return buildEmailChangeUrl(env.APP_BASE_URL, rawToken);
}

export default mailer;
