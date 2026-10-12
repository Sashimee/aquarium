import nodemailer, { type Transporter } from 'nodemailer';
import { RateLimiter, type Limit } from './rate-limit.ts';

export interface MailLimits {
  perRecipient: Limit;
  verificationCooldown: Limit;
  perIpSignup: Limit;
}

export const DEFAULT_MAIL_LIMITS: MailLimits = {
  perRecipient: { max: 5, windowMs: 60 * 60 * 1000 },
  verificationCooldown: { max: 1, windowMs: 60 * 1000 },
  perIpSignup: { max: 10, windowMs: 60 * 60 * 1000 },
};

export class MailThrottledError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('mail throttled');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function verificationMessage(url: string): { text: string; html: string } {
  const safe = escapeHtml(url);
  const text = `Confirm your email address to start your aquarium:\n\n${url}\n\nIf you did not sign up, ignore this message.\n`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#12202b">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">Welcome to your Aquarium</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 24px">Confirm your email address to start your aquarium.</p>
<p style="margin:0 0 24px"><a href="${safe}" style="display:inline-block;background:#0b7285;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:6px">Verify my email</a></p>
<p style="font-size:13px;line-height:1.5;margin:0 0 8px">Or open this link in your browser:</p>
<p style="font-size:13px;line-height:1.5;margin:0 0 24px;word-break:break-all"><a href="${safe}" style="color:#0b7285">${safe}</a></p>
<p style="font-size:13px;color:#5b6b78;margin:0">If you did not sign up, ignore this message.</p>
</div></body></html>
`;
  return { text, html };
}

export function createSmtpTransport(host: string, port: number): Transporter {
  return nodemailer.createTransport({ host, port, secure: false });
}

export interface Mailer {
  /** Throws MailThrottledError when the recipient is inside the verification cooldown or hourly cap. */
  sendVerification(to: string, url: string): Promise<void>;
  /** Consumes one per-IP slot for mail-triggering endpoints; returns retry-after seconds or 0. */
  consumeIp(ip: string): number;
  peekVerificationCooldown(to: string): number;
}

export function createMailer(
  transport: Transporter,
  mailFrom: string,
  limits: MailLimits = DEFAULT_MAIL_LIMITS,
): Mailer {
  const recipient = new RateLimiter();
  const cooldown = new RateLimiter();
  const ip = new RateLimiter();
  const from = `Aquarium <${mailFrom}>`;
  const key = (to: string) => to.trim().toLowerCase();

  return {
    async sendVerification(to, url) {
      const k = key(to);
      const wait = cooldown.consume(k, limits.verificationCooldown);
      if (wait > 0) throw new MailThrottledError(wait);
      const capped = recipient.consume(k, limits.perRecipient);
      if (capped > 0) throw new MailThrottledError(capped);
      await transport.sendMail({
        from,
        to,
        subject: 'Verify your Aquarium account',
        ...verificationMessage(url),
        // Quoted-printable would soft-wrap the long token URL; base64 keeps it intact.
        textEncoding: 'base64',
      });
    },
    consumeIp: (address) => ip.consume(address, limits.perIpSignup),
    peekVerificationCooldown(to) {
      return cooldown.remaining(key(to), limits.verificationCooldown);
    },
  };
}
