import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Config } from './config.ts';
import { schema, type Database } from './db/index.ts';
import { MailThrottledError, type Mailer } from './mail.ts';

export const AUTH_BASE_PATH = '/api/auth';
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;

export interface AuthRateLimits {
  signIn: { window: number; max: number };
  signUp: { window: number; max: number };
  sendVerification: { window: number; max: number };
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  signIn: { window: 60, max: 10 },
  signUp: { window: 3600, max: 10 },
  sendVerification: { window: 3600, max: 10 },
};

export interface AuthDeps {
  config: Pick<Config, 'authSecret' | 'appUrl' | 'trustedProxies'>;
  database: Database;
  mailer: Mailer;
  rateLimits?: AuthRateLimits;
}

export function createAuth({
  config,
  database,
  mailer,
  rateLimits = DEFAULT_AUTH_RATE_LIMITS,
}: AuthDeps) {
  const origin = config.appUrl.origin;
  const secure = config.appUrl.protocol === 'https:';

  return betterAuth({
    appName: 'Aquarium',
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [origin],
    logger: { level: 'error' },
    database: drizzleAdapter(database.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        passkey: schema.passkey,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        try {
          await mailer.sendVerification(user.email, user.name, url);
        } catch (err) {
          if (err instanceof MailThrottledError) return;
          console.error('verification mail failed:', err instanceof Error ? err.name : 'unknown');
        }
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
      // The Fastify layer overwrites x-forwarded-for with the proxy-validated client IP.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': rateLimits.signIn,
        '/sign-up/email': rateLimits.signUp,
        '/send-verification-email': rateLimits.sendVerification,
      },
    },
    plugins: [
      passkey({
        rpID: config.appUrl.hostname,
        rpName: 'Aquarium',
        origin,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
