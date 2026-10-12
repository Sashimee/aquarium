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

export function createSmtpTransport(host: string, port: number): Transporter {
  return nodemailer.createTransport({ host, port, secure: false });
}

export interface Mailer {
  /** Throws MailThrottledError when the recipient is inside the verification cooldown or hourly cap. */
  sendVerification(to: string, name: string, url: string): Promise<void>;
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
    async sendVerification(to, name, url) {
      const k = key(to);
      const wait = cooldown.consume(k, limits.verificationCooldown);
      if (wait > 0) throw new MailThrottledError(wait);
      const capped = recipient.consume(k, limits.perRecipient);
      if (capped > 0) throw new MailThrottledError(capped);
      await transport.sendMail({
        from,
        to,
        subject: 'Verify your Aquarium account',
        text: `Hi ${name},\n\nConfirm your email address to start your aquarium:\n${url}\n\nIf you did not sign up, ignore this message.\n`,
      });
    },
    consumeIp: (address) => ip.consume(address, limits.perIpSignup),
    peekVerificationCooldown(to) {
      return cooldown.remaining(key(to), limits.verificationCooldown);
    },
  };
}
