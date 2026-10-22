import { z } from 'zod';
import { parseVapidKeys, type VapidKeys } from './push.ts';

const MAIL_DOMAIN = 'bas.lu';

const DEFAULT_TRUSTED_PROXIES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.1',
  '::1',
];

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters')
    .regex(/^[A-Za-z0-9]+$/, 'must be alphanumeric (Dokploy corrupts + / =)'),
  APP_URL: z.url(),
  SMTP_HOST: z.string().min(1).default('mailrelay'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  MAIL_FROM: z.email().default(`fish@${MAIL_DOMAIN}`),
  SITE_INDEXABLE: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_DIST: z.string().default('../web/dist'),
  TRUSTED_PROXIES: z.string().optional(),
  NODE_ENV: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  REMINDER_DAILY_CAP: z.coerce.number().int().min(0).max(100_000).default(500),
});

export interface Config {
  databaseUrl: string;
  authSecret: string;
  appUrl: URL;
  smtp: { host: string; port: number };
  mailFrom: string;
  indexable: boolean;
  port: number;
  webRoot: string;
  trustedProxies: string[];
  testHooks: boolean;
  vapid: VapidKeys | null;
  vapidSubject: string;
  stripe: StripeKeys | null;
  reminderDailyCap: number;
}

export interface StripeKeys {
  secretKey: string;
  webhookSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}. See docs/deployment.md.`);
  }
  const e = parsed.data;

  if (!e.MAIL_FROM.toLowerCase().endsWith(`@${MAIL_DOMAIN}`)) {
    throw new Error(
      `MAIL_FROM must be an @${MAIL_DOMAIN} address: the OVH upstream rejects misaligned senders asynchronously.`,
    );
  }

  const appUrl = new URL(e.APP_URL);
  if (e.NODE_ENV === 'production' && appUrl.protocol !== 'https:') {
    throw new Error('APP_URL must be https in production: session cookies are Secure.');
  }

  if (Boolean(e.VAPID_PUBLIC_KEY) !== Boolean(e.VAPID_PRIVATE_KEY)) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together or not at all.');
  }
  const vapid =
    e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY
      ? parseVapidKeys(e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY)
      : null;
  const vapidSubject = e.VAPID_SUBJECT ?? `mailto:${e.MAIL_FROM}`;
  if (!/^(mailto:|https:\/\/)/.test(vapidSubject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL.');
  }

  const secretKey = e.STRIPE_SECRET_KEY?.trim() ?? '';
  const webhookSecret = e.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
  if (Boolean(secretKey) !== Boolean(webhookSecret)) {
    throw new Error(
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set together or not at all; with neither, payments stay disabled.',
    );
  }
  if (secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_... or sk_live_...).');
  }
  if (webhookSecret && !/^whsec_[A-Za-z0-9_]+$/.test(webhookSecret)) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe signing secret (whsec_...).');
  }

  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.BETTER_AUTH_SECRET,
    appUrl,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT },
    mailFrom: e.MAIL_FROM,
    indexable: e.SITE_INDEXABLE === 'true',
    port: e.PORT,
    webRoot: e.WEB_DIST,
    testHooks: e.NODE_ENV === 'test',
    vapid,
    vapidSubject,
    stripe: secretKey ? { secretKey, webhookSecret } : null,
    reminderDailyCap: e.REMINDER_DAILY_CAP,
    trustedProxies: e.TRUSTED_PROXIES
      ? e.TRUSTED_PROXIES.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_TRUSTED_PROXIES,
  };
}
