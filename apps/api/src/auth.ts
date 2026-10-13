import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
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
  passwordReset: { window: number; max: number };
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  signIn: { window: 60, max: 10 },
  signUp: { window: 3600, max: 10 },
  sendVerification: { window: 3600, max: 10 },
  passwordReset: { window: 3600, max: 10 },
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

  const throttleSafe = async (send: () => Promise<void>, what: string) => {
    try {
      await send();
    } catch (err) {
      if (err instanceof MailThrottledError) return;
      console.error(`${what} mail failed:`, err instanceof Error ? err.name : 'unknown');
    }
  };

  // Whoever signs up first chooses a password that the mailbox owner never saw. Dropping the
  // credential whenever an unverified account is contested or re-verified means the password
  // that exists after verification can only come from a reset mailed to the owner.
  const dropUnverifiedCredential = async (userId: string) => {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.deleteAccounts(userId);
    await internalAdapter.deleteUserSessions(userId);
  };

  const auth = betterAuth({
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
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        throttleSafe(() => mailer.sendPasswordReset(user.email, url), 'reset'),
      onExistingUserSignUp: async ({ user }) => {
        if (user.emailVerified) return;
        await dropUnverifiedCredential(user.id);
        await auth.api.sendVerificationEmail({ body: { email: user.email, callbackURL: '/' } });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        throttleSafe(() => mailer.sendVerification(user.email, url), 'verification'),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/send-verification-email') return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email !== 'string') return;
        const found = await ctx.context.internalAdapter.findUserByEmail(email);
        if (found && !found.user.emailVerified) await dropUnverifiedCredential(found.user.id);
      }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      // Better Auth skips origin/callbackURL checks under NODE_ENV=test unless this is explicit.
      disableOriginCheck: false,
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
        '/request-password-reset': rateLimits.passwordReset,
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

  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
