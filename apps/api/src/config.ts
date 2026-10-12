import { z } from 'zod';

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

  return {
    databaseUrl: e.DATABASE_URL,
    authSecret: e.BETTER_AUTH_SECRET,
    appUrl,
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT },
    mailFrom: e.MAIL_FROM,
    indexable: e.SITE_INDEXABLE === 'true',
    port: e.PORT,
    webRoot: e.WEB_DIST,
    trustedProxies: e.TRUSTED_PROXIES
      ? e.TRUSTED_PROXIES.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_TRUSTED_PROXIES,
  };
}
