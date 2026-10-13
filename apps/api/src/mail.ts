import { AsyncLocalStorage } from 'node:async_hooks';
import { isIPv4, isIPv6 } from 'node:net';
import nodemailer, { type Transporter } from 'nodemailer';
import { memoryHitStore, type HitStore, type Limit } from './rate-limit.ts';

export interface MailLimits {
  perRecipient: Limit;
  verificationCooldown: Limit;
  perIpSignup: Limit;
  /** Requests per IP to mail-triggering endpoints, charged whatever the global cap says. Defaults to perIpSignup. */
  perIpRequests?: Limit;
  global: Limit;
}

export const DEFAULT_MAIL_LIMITS: MailLimits = {
  perRecipient: { max: 5, windowMs: 60 * 60 * 1000 },
  verificationCooldown: { max: 1, windowMs: 60 * 1000 },
  perIpSignup: { max: 10, windowMs: 60 * 60 * 1000 },
  global: { max: 200, windowMs: 60 * 60 * 1000 },
};

export interface IpAdmission {
  /** Seconds until the IP may try again, or 0 when the request may proceed. */
  wait: number;
  /** Seconds the global cap is spent for, or 0. While positive no mail may go out for this request, and the IP slot is charged only if the cap was reached after the IP check. */
  mailBlockedFor: number;
  /** The request already took its one global slot, so sending must not take another. */
  globalCharged?: boolean;
}

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
  const text = `Confirm your email address to start your aquarium:\n\n<${url}>\n\nOpen the link in the same browser you signed up in. If you open it on another device, your password will not carry over; set one with Forgot password instead.\n\nIf you did not sign up, ignore this message.\n`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Verify your Aquarium account</title></head><body style="margin:0;padding:24px;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#12202b">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">Welcome to your Aquarium</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 24px">Confirm your email address to start your aquarium.</p>
<p style="margin:0 0 24px"><a href="${safe}" style="display:inline-block;background:#0b7285;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:6px">Verify my email</a></p>
<p style="font-size:13px;line-height:1.5;margin:0 0 8px">Or open this link in your browser:</p>
<p style="font-size:13px;line-height:1.5;margin:0 0 24px;word-break:break-all"><a href="${safe}" style="color:#0b7285">${safe}</a></p>
<p style="font-size:13px;line-height:1.5;margin:0 0 8px">Open the link in the same browser you signed up in. If you open it on another device, your password will not carry over; set one with Forgot password instead.</p>
<p style="font-size:13px;color:#5b6b78;margin:0">If you did not sign up, ignore this message.</p>
</div></body></html>
`;
  return { text, html };
}

export function passwordResetMessage(url: string): { text: string; html: string } {
  const safe = escapeHtml(url);
  const text = `Set a new password for your aquarium account:\n\n<${url}>\n\nThe link works once and expires in one hour. If you did not ask for this, ignore this message.\n`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Reset your Aquarium password</title></head><body style="margin:0;padding:24px;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#12202b">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">Set a new password</h1>
<p style="margin:0 0 24px"><a href="${safe}" style="display:inline-block;background:#0b7285;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:6px">Choose a password</a></p>
<p style="font-size:13px;line-height:1.5;margin:0 0 8px">Or open this link in your browser:</p>
<p style="font-size:13px;line-height:1.5;margin:0 0 24px;word-break:break-all"><a href="${safe}" style="color:#0b7285">${safe}</a></p>
<p style="font-size:13px;color:#5b6b78;margin:0">The link works once and expires in one hour. If you did not ask for this, ignore this message.</p>
</div></body></html>
`;
  return { text, html };
}

export function createSmtpTransport(host: string, port: number): Transporter {
  return nodemailer.createTransport({ host, port, secure: false });
}

export interface Mailer {
  /** Throws MailThrottledError when the recipient is inside the verification cooldown or hourly cap, or the global cap is spent. */
  sendVerification(to: string, url: string): Promise<void>;
  /** Same limits as sendVerification, tracked separately so one flow cannot starve the other. */
  sendPasswordReset(to: string, url: string): Promise<void>;
  /**
   * Charges one flat per-IP slot per mail-triggering request, whatever the recipient; the mail slot is not charged while the global cap is spent.
   * A separate request counter is always charged first, in the shared store, so an IP cannot outrun its limit during a cap outage.
   * With chargeGlobal the request also takes exactly one global slot up front, whether or not a mail follows,
   * so the global counter cannot reveal if the address has an account.
   */
  consumeIp(ip: string, options?: { chargeGlobal?: boolean }): Promise<IpAdmission>;
  /** Mail sent inside `work` honours the admission: a request admitted without an IP charge sends nothing. */
  runAdmitted<T>(admission: IpAdmission, work: () => Promise<T>): Promise<T>;
}

export interface MailerOptions {
  limits?: MailLimits;
  store?: HitStore;
  log?: (message: string) => void;
}

export const GLOBAL_CAP_EVENT = 'mail_global_cap_reached';
const STORE_FAILURE_RETRY_SECONDS = 60;
const SHARED_INBOX_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// The same inbox must map to one budget: strip +tag everywhere, and Gmail's dots and alias domain.
export function recipientKey(address: string): string {
  const lowered = address.trim().toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at < 1) return lowered;
  let local = lowered.slice(0, at);
  let domain = lowered.slice(at + 1);
  local = local.split('+')[0] ?? local;
  if (SHARED_INBOX_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

// A residential IPv6 customer holds a whole /64, so per-address keys would let one host rotate through 2^64 budgets.
// Anything unparseable is keyed on the raw string: it still gets a budget instead of throwing.
export function ipBucket(address: string): string {
  const unzoned = address.split('%')[0] ?? address;
  if (isIPv4(unzoned)) return unzoned;
  if (!isIPv6(unzoned)) return address;
  const groups = expandIpv6(unzoned);
  if (!groups) return address;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  }
  return `${[g0, g1, g2, g3].map((g) => g.toString(16)).join(':')}::/64`;
}

function expandIpv6(address: string): number[] | undefined {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

export function createMailer(
  transport: Transporter,
  mailFrom: string,
  {
    limits = DEFAULT_MAIL_LIMITS,
    store = memoryHitStore(),
    log = console.error,
  }: MailerOptions = {},
): Mailer {
  const from = `Aquarium <${mailFrom}>`;
  const admissions = new AsyncLocalStorage<IpAdmission>();
  let globalCapLogged = false;
  let storeFailureLogged = false;

  // A broken store must stop mail, not let it through unmetered.
  const guarded = async (
    work: () => Promise<number>,
  ): Promise<{ wait: number; answered: boolean }> => {
    try {
      const wait = await work();
      storeFailureLogged = false;
      return { wait, answered: true };
    } catch (err) {
      if (!storeFailureLogged) {
        storeFailureLogged = true;
        log(
          `mail limiter unavailable, refusing mail: ${err instanceof Error ? err.name : 'unknown'}`,
        );
      }
      return { wait: STORE_FAILURE_RETRY_SECONDS, answered: false };
    }
  };

  const failClosed = async (work: () => Promise<number>): Promise<number> =>
    (await guarded(work)).wait;

  const consume = (key: string, limit: Limit) => failClosed(() => store.consume(key, limit));

  // Only a store that answered means the cap is spent; a failure is already logged as unavailable.
  const logGlobalCap = (retryAfterSeconds: number, answered: boolean) => {
    if (!answered || globalCapLogged) return;
    globalCapLogged = true;
    log(
      JSON.stringify({
        level: 'error',
        event: GLOBAL_CAP_EVENT,
        msg: 'global mail cap reached',
        limit: limits.global.max,
        windowSeconds: limits.global.windowMs / 1000,
        retryAfterSeconds,
      }),
    );
  };

  const refuseGlobal = (retryAfterSeconds: number, answered: boolean): never => {
    logGlobalCap(retryAfterSeconds, answered);
    throw new MailThrottledError(retryAfterSeconds);
  };

  const admit = async (flow: 'verify' | 'reset', to: string) => {
    // The cap may have freed since consumeIp skipped the IP charge; sending now would be unmetered per IP.
    const admission = admissions.getStore();
    if (admission && admission.mailBlockedFor > 0) {
      const now = await guarded(() => store.remaining('global', limits.global));
      if (now.wait > 0) return refuseGlobal(now.wait, now.answered);
      throw new MailThrottledError(admission.mailBlockedFor);
    }
    const k = recipientKey(to);
    if (admission?.globalCharged) {
      const wait = await consume(`${flow}:cooldown:${k}`, limits.verificationCooldown);
      if (wait > 0) throw new MailThrottledError(wait);
      const capped = await consume(`recipient:${k}`, limits.perRecipient);
      if (capped > 0) throw new MailThrottledError(capped);
      return;
    }
    // Peek first so a spent global cap refuses without using up the recipient's own budget.
    const spent = await guarded(() => store.remaining('global', limits.global));
    if (spent.wait > 0) return refuseGlobal(spent.wait, spent.answered);
    const wait = await consume(`${flow}:cooldown:${k}`, limits.verificationCooldown);
    if (wait > 0) throw new MailThrottledError(wait);
    const capped = await consume(`recipient:${k}`, limits.perRecipient);
    if (capped > 0) throw new MailThrottledError(capped);
    const final = await guarded(() => store.consume('global', limits.global));
    if (final.wait > 0) return refuseGlobal(final.wait, final.answered);
    globalCapLogged = false;
  };

  return {
    async sendVerification(to, url) {
      await admit('verify', to);
      await transport.sendMail({
        from,
        to,
        subject: 'Verify your Aquarium account',
        ...verificationMessage(url),
        // Quoted-printable would soft-wrap the long token URL; base64 keeps it intact.
        textEncoding: 'base64',
      });
    },
    async sendPasswordReset(to, url) {
      await admit('reset', to);
      await transport.sendMail({
        from,
        to,
        subject: 'Reset your Aquarium password',
        ...passwordResetMessage(url),
        textEncoding: 'base64',
      });
    },
    // The charge is flat per request: refunding it for a recipient or cooldown refusal would let the
    // IP's 429 behaviour reveal whether the address has an account. Only the shared global counter,
    // which does not depend on the address, may skip it.
    async consumeIp(address, { chargeGlobal = false } = {}) {
      const key = `ip:${ipBucket(address)}`;
      const requestWait = await consume(`req:${key}`, limits.perIpRequests ?? limits.perIpSignup);
      if (requestWait > 0) return { wait: requestWait, mailBlockedFor: 0 };
      const spent = await guarded(() => store.remaining('global', limits.global));
      if (spent.answered && spent.wait > 0) {
        logGlobalCap(spent.wait, true);
        const wait = await failClosed(() => store.remaining(key, limits.perIpSignup));
        return { wait, mailBlockedFor: spent.wait };
      }
      if (spent.answered) globalCapLogged = false;
      const wait = await consume(key, limits.perIpSignup);
      if (!chargeGlobal || wait > 0) return { wait, mailBlockedFor: 0 };
      const taken = await guarded(() => store.consume('global', limits.global));
      if (taken.wait > 0) {
        logGlobalCap(taken.wait, taken.answered);
        return { wait: 0, mailBlockedFor: taken.wait };
      }
      return { wait: 0, mailBlockedFor: 0, globalCharged: true };
    },
    runAdmitted: (admission, work) => admissions.run(admission, work),
  };
}
