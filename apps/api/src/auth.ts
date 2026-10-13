import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, createEmailVerificationToken } from 'better-auth/api';
import { createHmac, timingSafeEqual } from 'node:crypto';
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

  const SIGNUP_COOKIE = 'aq_signup';
  const SIGNUP_COOKIE_MAX_AGE = 60 * 60 * 24;
  const signupProof = (userId: string) =>
    `${userId}.${createHmac('sha256', config.authSecret).update(`signup:${userId}`).digest('base64url')}`;

  const holdsSignupProof = (request: Request | undefined, userId: string): boolean => {
    const header = request?.headers.get('cookie') ?? '';
    const sent = header
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SIGNUP_COOKIE}=`))
      ?.slice(SIGNUP_COOKIE.length + 1);
    if (!sent) return false;
    const expected = Buffer.from(signupProof(userId));
    const actual = Buffer.from(sent);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  // Anyone can sign up with someone else's address and choose its password. A verification link
  // is proof of the mailbox, not of the password, so the password only survives verification in
  // the browser that signed up. Otherwise the credential is dropped and the owner sets one by reset.
  const dropUnverifiedCredential = async (userId: string) => {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.deleteAccounts(userId);
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
        const token = await createEmailVerificationToken(config.authSecret, user.email);
        const url = `${origin}${AUTH_BASE_PATH}/verify-email?token=${token}&callbackURL=${encodeURIComponent('/')}`;
        await throttleSafe(() => mailer.sendVerification(user.email, url), 'verification');
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      beforeEmailVerification: async (user, request) => {
        const { internalAdapter } = await auth.$context;
        await internalAdapter.deleteUserSessions(user.id);
        if (!holdsSignupProof(request, user.id)) await dropUnverifiedCredential(user.id);
      },
      sendVerificationEmail: ({ user, url }, request) =>
        throttleSafe(async () => {
          // Sign-up and resend consume the IP budget in the HTTP layer; sign-in only learns it
          // owes a mail here, after the password checked out.
          if (request && new URL(request.url).pathname === `${AUTH_BASE_PATH}/sign-in/email`) {
            const ip = request.headers.get('x-forwarded-for');
            if ((await mailer.consumeIp(ip ?? 'unknown')) > 0) return;
          }
          await mailer.sendVerification(user.email, url);
        }, 'verification'),
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const userId = (ctx.context.returned as { user?: { id?: unknown } } | undefined)?.user?.id;
        if (typeof userId !== 'string') return;
        ctx.setCookie(SIGNUP_COOKIE, signupProof(userId), {
          httpOnly: true,
          sameSite: 'lax',
          secure,
          path: '/',
          maxAge: SIGNUP_COOKIE_MAX_AGE,
        });
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
