import logger from '../middleware/logger.js';
import { env } from '../config/env.js';

// Outbound mail seam. The app depends on this interface, never on a vendor —
// swapping Resend for SES/SMTP is a new adapter and one line in `createMailer`,
// with no route or model changes. Kept deliberately narrow: this codebase sends
// exactly one kind of message, and a generic `send(subject, html)` would invite
// call sites to compose mail inline.
export interface Mailer {
  sendVerificationEmail(params: { to: string; verifyUrl: string }): Promise<void>;
}

const mailLogger = logger.child({ module: 'mailer' });

const SUBJECT = 'Verify your email address';

const bodyText = (verifyUrl: string): string =>
  [
    'Confirm your email address to finish setting up your account:',
    '',
    verifyUrl,
    '',
    `This link expires in ${env.VERIFICATION_TOKEN_EXPIRY_HOURS} hours and can only be used once.`,
    "If you didn't create this account, you can ignore this message.",
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

  async sendVerificationEmail({ to, verifyUrl }: { to: string; verifyUrl: string }): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: SUBJECT,
        text: bodyText(verifyUrl),
      }),
    });

    if (!res.ok) {
      // Body may carry the provider's reason; truncate so a hostile or verbose
      // response can't flood the logs. The address is NOT logged — it is the
      // PII this whole flow exists to protect (see logger redaction).
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Resend rejected the verification email (HTTP ${res.status}): ${detail}`);
    }
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

export default mailer;
