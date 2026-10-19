import { safeError } from './safe-error.ts';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  type ChemistryParameters,
  revokeSessionRequestSchema,
  signUpRequestSchema,
  signInRequestSchema,
  updateUserRequestSchema,
  changePasswordRequestSchema,
  emailSchema,
  sessionListSchema,
  userSchema,
} from '@aquarium/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z, ZodError } from 'zod';
import { AUTH_BASE_PATH, RESET_REDIRECT_PATH, VERIFY_CALLBACK_PATH, type Auth } from './auth.ts';
import { createClock, type Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { loadCredits } from './credits.ts';
import { DEFAULT_COLLECTION_LIMIT, registerCollectionRoutes } from './collection.ts';
import { DEFAULT_HANDLE_LIMIT, registerHandleRoutes } from './handle.ts';
import { DEFAULT_PUBLIC_LIMITS, registerPublicRoutes, type PublicLimits } from './public.ts';
import { normalizedPathname } from './url.ts';
import { DEFAULT_LEGAL_LIMITS, registerLegalRoutes, type LegalLimits } from './legal.ts';
import type { IpAdmission, Mailer } from './mail.ts';
import { RateLimiter, type Limit, type ResettableHitStore } from './rate-limit.ts';
import type { PushSender } from './push.ts';
import {
  DEFAULT_REMINDER_LIMITS,
  registerReminderRoutes,
  UNSUBSCRIBE_PATH,
  type ReminderLimits,
} from './reminders.ts';
import type { SpeciesCatalog } from './species.ts';
import { DEFAULT_CARE_LIMITS, registerTankRoutes, type CareLimits } from './tanks.ts';

export interface AppOptions {
  indexable: boolean;
  webRoot: string;
  appOrigin: string;
  trustedProxies: string[];
  database: Database;
  auth: Auth;
  mailer: Mailer;
  signInThrottle: { store: ResettableHitStore; limit: Limit };
  species: SpeciesCatalog;
  chemistryParams: ChemistryParameters;
  clock?: Clock;
  careLimits?: CareLimits;
  legalLimits?: LegalLimits;
  authSecret: string;
  push?: PushSender | null;
  reminderLimits?: ReminderLimits;
  handleLimit?: Limit;
  collectionLimit?: Limit;
  publicLimits?: PublicLimits;
  testHooks?: boolean;
  logger?: boolean;
  logStream?: { write(chunk: string): void };
}

const HELLO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aquarium</title></head>
<body><h1>Aquarium</h1><p>Coming soon.</p></body></html>`;

const STATIC_EXTENSIONS = new Set([
  'js',
  'mjs',
  'css',
  'map',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'glb',
  'gltf',
  'ktx2',
  'bin',
  'json',
  'txt',
  'xml',
  'wasm',
  'mp3',
  'ogg',
  'webmanifest',
  'hdr',
  'exr',
  'html',
]);

const advanceTimeRequestSchema = z.strictObject({
  minutes: z
    .number()
    .positive()
    .max(60 * 24 * 365),
});

// Only the two pages that carry a no-referrer policy may be named, so the values are pinned
// instead of validated. Better Auth appends the reset token to redirectTo, so any other path would
// land it on a page that leaks or ignores it; the verify token travels in the mail link's query to
// the API, and callbackURL is only where the browser lands afterwards.
const resetRedirectSchema = z.literal(RESET_REDIRECT_PATH, {
  error: `redirectTo must be exactly ${RESET_REDIRECT_PATH}.`,
});
const verifyCallbackSchema = z.literal(VERIFY_CALLBACK_PATH, {
  error: `callbackURL must be exactly ${VERIFY_CALLBACK_PATH}.`,
});

const signUpBodySchema = signUpRequestSchema.extend({
  callbackURL: verifyCallbackSchema.optional(),
});

const signInBodySchema = signInRequestSchema.extend({
  callbackURL: verifyCallbackSchema.optional(),
  rememberMe: z.boolean().optional(),
});

const requestPasswordResetBodySchema = z.strictObject({
  email: emailSchema,
  redirectTo: resetRedirectSchema.default(RESET_REDIRECT_PATH),
});

const sendVerificationEmailBodySchema = z.strictObject({
  email: emailSchema,
  callbackURL: verifyCallbackSchema.optional(),
});

const BODY_SCHEMAS = new Map<string, z.ZodType>([
  [`${AUTH_BASE_PATH}/sign-up/email`, signUpBodySchema],
  [`${AUTH_BASE_PATH}/sign-in/email`, signInBodySchema],
  [`${AUTH_BASE_PATH}/update-user`, updateUserRequestSchema],
  [`${AUTH_BASE_PATH}/change-password`, changePasswordRequestSchema],
  [`${AUTH_BASE_PATH}/request-password-reset`, requestPasswordResetBodySchema],
  [`${AUTH_BASE_PATH}/send-verification-email`, sendVerificationEmailBodySchema],
]);

function parseJson(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    throw new ZodError([{ code: 'custom', path: [], message: 'Body must be valid JSON.' }]);
  }
}

export const DEFAULT_SIGN_IN_THROTTLE: Limit = { max: 10, windowMs: 15 * 60_000 };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED_AUTH_PATHS = new Set([
  `${AUTH_BASE_PATH}/list-sessions`,
  `${AUTH_BASE_PATH}/revoke-session`,
  `${AUTH_BASE_PATH}/revoke-sessions`,
  `${AUTH_BASE_PATH}/revoke-other-sessions`,
  `${AUTH_BASE_PATH}/change-email`,
  `${AUTH_BASE_PATH}/delete-user`,
  `${AUTH_BASE_PATH}/delete-user/callback`,
  `${AUTH_BASE_PATH}/account-info`,
  `${AUTH_BASE_PATH}/get-access-token`,
  `${AUTH_BASE_PATH}/refresh-token`,
  `${AUTH_BASE_PATH}/link-social`,
  `${AUTH_BASE_PATH}/unlink-account`,
  `${AUTH_BASE_PATH}/list-accounts`,
  `${AUTH_BASE_PATH}/sign-in/social`,
  `${AUTH_BASE_PATH}/update-session`,
  `${AUTH_BASE_PATH}/verify-password`,
  `${AUTH_BASE_PATH}/passkey/delete-passkey`,
  `${AUTH_BASE_PATH}/passkey/list-user-passkeys`,
  `${AUTH_BASE_PATH}/passkey/update-passkey`,
]);

// Better Auth echoes the session token in get-session, sign-in, sign-up and passkey bodies. The
// same value is the HttpOnly cookie, so any key named token is dropped before JS can read it.
export function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'token')
      .map(([key, inner]) => [key, stripTokens(inner)]),
  );
}

export function stripTokensFromBody(raw: string): string | null {
  try {
    return JSON.stringify(stripTokens(JSON.parse(raw)));
  } catch {
    return null;
  }
}

// Better Auth resolves the request through the WHATWG URL parser, which collapses dot segments
// (also percent-encoded) and treats a backslash as a slash. Path-based rules here compare a literal
// string, so any path the parser would rewrite is refused instead of being matched differently.
function hasAmbiguousPath(url: string): boolean {
  if (url.includes('#')) return true;
  const raw = url.split('?')[0] ?? '';
  if (raw.includes('\\') || raw.includes('//')) return true;
  return raw.split('/').some((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    return decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
  });
}

const PUBLIC_PATH_PREFIX = '/api/public/';
const VIEWER_PATH_PREFIX = '/t/';
const TOKEN_PATH_PREFIXES = [`${AUTH_BASE_PATH}/reset-password/`, `${AUTH_BASE_PATH}/callback/`];
// Pages and links whose URL holds a one-time token. The strict-origin-when-cross-origin default
// would still send the full URL to same-origin subresources (JS, CSS, /api/me) on first load. The
// policy stays scoped: the CSRF check falls back to Referer and the default suits every other route.
const TOKEN_PAGES = new Set(['/reset-password', '/verify-email']);

function isViewerPath(url: string): boolean {
  return normalizedPathname(url).toLowerCase().startsWith(VIEWER_PATH_PREFIX);
}

function carriesUrlToken(url: string): boolean {
  const path = normalizedPathname(url).toLowerCase().replace(/\/+$/, '');
  return (
    TOKEN_PAGES.has(path) ||
    path === `${AUTH_BASE_PATH}/verify-email` ||
    path === UNSUBSCRIBE_PATH ||
    path.startsWith(PUBLIC_PATH_PREFIX) ||
    path.startsWith(VIEWER_PATH_PREFIX) ||
    TOKEN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9]{20,}$/;

export function redactUrl(url: string): string {
  const path = normalizedPathname(url);
  const lower = path.toLowerCase();
  if (lower.startsWith(PUBLIC_PATH_PREFIX))
    return `${path.slice(0, PUBLIC_PATH_PREFIX.length)}[redacted]`;
  if (lower.startsWith(VIEWER_PATH_PREFIX))
    return `${path.slice(0, VIEWER_PATH_PREFIX.length)}[redacted]`;
  const prefix = TOKEN_PATH_PREFIXES.find((p) => lower.startsWith(p));
  if (prefix) {
    const rest = path.slice(prefix.length);
    if (prefix.endsWith('/callback/')) {
      const provider = rest.split('/')[0] ?? '';
      return `${path.slice(0, prefix.length)}${provider}`;
    }
    return `${path.slice(0, prefix.length)}[redacted]`;
  }
  if (!lower.startsWith(`${AUTH_BASE_PATH}/`)) return path;
  return path
    .split('/')
    .map((seg) => (TOKEN_LIKE_SEGMENT.test(seg) ? '[redacted]' : seg))
    .join('/');
}

function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 && STATIC_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

async function isUnverified(res: Response): Promise<boolean> {
  let body: { code?: unknown };
  try {
    body = (await res.clone().json()) as { code?: unknown };
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
  return body.code === 'EMAIL_NOT_VERIFIED';
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { indexable, webRoot, appOrigin, database, auth, mailer, logger = true } = opts;
  const clock = opts.clock ?? createClock();
  const { signInThrottle } = opts;
  const secure = new URL(appOrigin).protocol === 'https:';
  const applySecurityHeaders = (reply: FastifyReply): void => {
    reply.headers(SECURITY_HEADERS);
    if (secure) reply.header('strict-transport-security', HSTS);
    if (!indexable) reply.header('x-robots-tag', 'noindex, nofollow');
  };
  const app = Fastify({
    // Fastify answers an undecodable URL (GET /%), an over-long path param (414) and a failed async
    // constraint (500) before routing, so no hook runs for them.
    frameworkErrors: (err, _req, reply: FastifyReply) => {
      applySecurityHeaders(reply);
      const status = err.statusCode ?? 500;
      const body = JSON.stringify(
        status >= 500
          ? apiError('internal', 'Internal server error.')
          : apiError('validation_failed', 'Malformed request.'),
      );
      return reply.code(status).type('application/json; charset=utf-8').send(body);
    },
    trustProxy: opts.trustedProxies,
    rewriteUrl: (req) => (req.url ?? '/').replace(/^\/{2,}/, '/'),
    logger: logger
      ? {
          ...(opts.logStream ? { stream: opts.logStream } : {}),
          serializers: {
            // stack embeds the unredacted message, params included
            err: (e: FastifyError) => ({ ...safeError(e), stack: '' }),
            req: (req: FastifyRequest) => ({
              method: req.method,
              url: redactUrl(req.url),
            }),
          },
        }
      : false,
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('Body must be valid JSON.'), { statusCode: 400 }), undefined);
    }
  });

  // Mail providers post the RFC 8058 one-click body as a form (urlencoded or multipart); the
  // body is never read, so no other route may accept one.
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data']) {
    app.addContentTypeParser(type, { parseAs: 'string' }, (req, body, done) => {
      if (normalizedPathname(req.url) !== UNSUBSCRIBE_PATH) {
        return done(
          Object.assign(new Error('Unsupported content type.'), { statusCode: 415 }),
          undefined,
        );
      }
      done(null, body);
    });
  }

  app.addHook('onSend', async (req, reply) => {
    applySecurityHeaders(reply);
    if (
      (reply.statusCode === 200 || reply.statusCode === 304) &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      normalizedPathname(req.url) === KTX2_WORKER_PATH
    ) {
      reply.header('content-security-policy', KTX2_WORKER_CSP);
    }
    if (carriesUrlToken(req.url)) reply.header('referrer-policy', 'no-referrer');
    if (isViewerPath(req.url)) reply.header('x-robots-tag', 'noindex, nofollow');
  });

  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || !normalizedPathname(req.url).startsWith('/api/')) return;
    if (!req.headers.cookie) return;
    // The confirm page posts under no-referrer, so browsers send Origin: null; the signed token is the credential here.
    if (normalizedPathname(req.url) === UNSUBSCRIBE_PATH) return;
    const sent = req.headers.origin ?? originOf(req.headers.referer);
    if (sent !== appOrigin) {
      return reply.code(403).send(apiError('forbidden', 'Cross-origin request rejected.'));
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send(
        apiError(
          'validation_failed',
          'Request validation failed.',
          err.issues.map((i) => ({
            path: i.path.filter((p) => typeof p !== 'symbol'),
            message: i.message,
          })),
        ),
      );
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413 || status === 415) {
      return reply
        .code(status)
        .send(
          status === 413
            ? apiError('payload_too_large', 'Body too large.')
            : apiError('unsupported_media_type', 'Unsupported content type.'),
        );
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send(apiError('validation_failed', 'Malformed request.'));
    }
    app.log.error({ err }, 'unhandled error');
    return reply.code(500).send(apiError('internal', 'Internal server error.'));
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await database.pool.query('select 1');
      return { status: 'ok' };
    } catch {
      app.log.error('health check: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain');
    return indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n';
  });

  async function currentSession(req: FastifyRequest) {
    return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  }

  const tooMany = (reply: FastifyReply, retryAfter: number) =>
    reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send(apiError('rate_limited', 'Too many requests. Try again later.'));

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.route({
      method: ['GET', 'POST'],
      url: `${AUTH_BASE_PATH}/*`,
      handler: async (req, reply) => {
        if (hasAmbiguousPath(req.url)) {
          return reply.code(404).send(apiError('not_found', 'Not found.'));
        }
        const pathname = normalizedPathname(req.url);
        if (BLOCKED_AUTH_PATHS.has(pathname)) {
          return reply.code(404).send(apiError('not_found', 'Not found.'));
        }
        let raw = typeof req.body === 'string' ? req.body : undefined;
        let admission: IpAdmission = { wait: 0, mailBlockedFor: 0 };

        const bodySchema = req.method === 'POST' ? BODY_SCHEMAS.get(pathname) : undefined;
        if (bodySchema) raw = JSON.stringify(bodySchema.parse(parseJson(raw)));

        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/sign-up/email`) {
          admission = await mailer.consumeIp(req.ip, { chargeGlobal: true });
          if (admission.wait > 0) return tooMany(reply, admission.wait);
        }
        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/request-password-reset`) {
          admission = await mailer.consumeIp(req.ip, { chargeGlobal: true });
          if (admission.wait > 0) return tooMany(reply, admission.wait);
        }
        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/send-verification-email`) {
          admission = await mailer.consumeIp(req.ip, { chargeGlobal: true });
          if (admission.wait > 0) return tooMany(reply, admission.wait);
        }

        // A slot is taken before the password is checked, so concurrent guesses cannot all slip
        // under the cap; a sign-in that gets past the password check gives the slots back. The key
        // is the email as typed, never the account, so the 429 is the same for unknown addresses.
        let failureKey: string | undefined;
        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/sign-in/email`) {
          const { email } = signInBodySchema.parse(parseJson(raw));
          failureKey = `signin-fail:${email.toLowerCase()}`;
          const wait = await signInThrottle.store.consume(failureKey, signInThrottle.limit);
          if (wait > 0) return tooMany(reply, wait);
        }
        // Same slot-first scheme keyed by the signed-in user. Without a session there is nothing to
        // guess against, so Better Auth answers 401 on its own.
        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/change-password`) {
          const current = await currentSession(req);
          if (current) {
            failureKey = `pw-change-fail:${current.user.id}`;
            const wait = await signInThrottle.store.consume(failureKey, signInThrottle.limit);
            if (wait > 0) return tooMany(reply, wait);
          }
        }

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || name === 'x-forwarded-for' || name === 'content-length')
            continue;
          if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
          else headers.set(name, value);
        }
        headers.set('x-forwarded-for', req.ip);

        const request = new Request(new URL(req.url, appOrigin), {
          method: req.method,
          headers,
          ...(req.method === 'POST' && raw !== undefined ? { body: raw } : {}),
        });
        const res = await mailer.runAdmitted(admission, () => auth.handler(request));
        // Better Auth also answers 403 before looking at the password (missing, null or foreign
        // origin, or cross-site navigation), so on sign-in only its EMAIL_NOT_VERIFIED, raised
        // after the password matched, counts as a success next to 200. change-password has no such case:
        // every non-200 is either a rejection before the check or the wrong password.
        const unverifiedSignIn =
          pathname === `${AUTH_BASE_PATH}/sign-in/email` &&
          res.status === 403 &&
          (await isUnverified(res));
        if (failureKey && (res.status === 200 || unverifiedSignIn)) {
          await signInThrottle.store.reset(failureKey);
        }

        const payload = Buffer.from(await res.arrayBuffer());
        const isJson = (res.headers.get('content-type') ?? '').toLowerCase().includes('json');
        const stripped =
          isJson && payload.length > 0 ? stripTokensFromBody(payload.toString('utf8')) : undefined;
        if (stripped === null) {
          req.log.warn(
            { path: redactUrl(req.url), status: res.status },
            'auth proxy: upstream returned an unparseable JSON body',
          );
          return reply
            .code(502)
            .send(apiError('internal', 'Authentication service returned an invalid response.'));
        }

        reply.code(res.status);
        res.headers.forEach((value, name) => {
          if (name === 'set-cookie' || name === 'content-length' || name === 'transfer-encoding')
            return;
          reply.header(name, value);
        });
        const cookies = res.headers.getSetCookie();
        if (cookies.length > 0) reply.header('set-cookie', cookies);
        if (stripped === undefined) return reply.send(payload);
        return reply.send(stripped);
      },
    });
  });

  app.get('/api/me', async (req, reply) => {
    const current = await currentSession(req);
    if (!current) return reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
    const { user } = current;
    return userSchema.parse({
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt.toISOString(),
    });
  });

  app.get('/api/sessions', async (req, reply) => {
    const current = await currentSession(req);
    if (!current) return reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
    const rows = await database.db
      .select()
      .from(schema.session)
      .where(
        and(eq(schema.session.userId, current.user.id), gt(schema.session.expiresAt, sql`now()`)),
      )
      .orderBy(desc(schema.session.createdAt));
    return sessionListSchema.parse(
      rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        userAgent: s.userAgent,
        current: s.id === current.session.id,
      })),
    );
  });

  app.post('/api/sessions/revoke', async (req, reply) => {
    const current = await currentSession(req);
    if (!current) return reply.code(401).send(apiError('unauthenticated', 'Sign in required.'));
    const { sessionId } = revokeSessionRequestSchema.parse(req.body);
    const deleted = await database.db
      .delete(schema.session)
      .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, current.user.id)))
      .returning({ id: schema.session.id });
    if (deleted.length === 0) {
      return reply.code(404).send(apiError('not_found', 'Session not found.'));
    }
    return reply.code(204).send();
  });

  const limiter = new RateLimiter();

  registerLegalRoutes({
    app,
    database,
    auth,
    credits: loadCredits(),
    limiter: new RateLimiter(),
    limits: opts.legalLimits ?? DEFAULT_LEGAL_LIMITS,
    currentSession,
  });

  registerReminderRoutes({
    app,
    database,
    push: opts.push ?? null,
    authSecret: opts.authSecret,
    limiter,
    limits: opts.reminderLimits ?? DEFAULT_REMINDER_LIMITS,
    currentUser: async (req) => (await currentSession(req))?.user ?? null,
  });

  registerTankRoutes({
    app,
    database,
    species: opts.species,
    chemistryParams: opts.chemistryParams,
    clock,
    limiter,
    limits: opts.careLimits ?? DEFAULT_CARE_LIMITS,
    currentUser: async (req) => (await currentSession(req))?.user ?? null,
  });

  registerCollectionRoutes({
    app,
    database,
    species: opts.species,
    limiter,
    limit: opts.collectionLimit ?? DEFAULT_COLLECTION_LIMIT,
    now: () => clock.now(),
    currentUser: async (req) => (await currentSession(req))?.user ?? null,
  });

  registerHandleRoutes({
    app,
    database,
    limiter,
    limit: opts.handleLimit ?? DEFAULT_HANDLE_LIMIT,
    currentUser: async (req) => (await currentSession(req))?.user ?? null,
  });

  registerPublicRoutes({
    app,
    database,
    limiter,
    limits: opts.publicLimits ?? DEFAULT_PUBLIC_LIMITS,
    currentUser: async (req) => (await currentSession(req))?.user ?? null,
  });

  if (opts.testHooks) {
    app.post('/api/test/advance-time', async (req, reply) => {
      const { minutes } = advanceTimeRequestSchema.parse(req.body);
      clock.advance(minutes * 60_000);
      return reply.code(204).send();
    });
  }

  const root = resolve(webRoot);
  const hasWeb = existsSync(resolve(root, 'index.html'));
  if (hasWeb) {
    void app.register(fastifyStatic, {
      root,
      dotfiles: 'ignore',
      preCompressed: true,
      cacheControl: false,
      setHeaders: (res, path) => {
        res.header('cache-control', staticCacheControl(relative(root, path)));
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const pathname = normalizedPathname(req.url);
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isApi || !isRead) return reply.code(404).send(apiError('not_found', 'Not found.'));
    if (isStaticAsset(pathname)) return reply.code(404).send('Not found');
    return hasWeb ? reply.sendFile('index.html') : reply.type('text/html').send(HELLO_PAGE);
  });

  return app;
}

// wasm-unsafe-eval: meshopt and the basis transcoder. img-src blob: the account export download.
// worker-src blob: kept for three's own loaders; the KTX2 worker is a same-origin file instead.
// style-src unsafe-inline: the inline <style> in index.html and React style= attributes.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// The basis transcoder's embind glue calls new Function, and wasm-unsafe-eval does not cover that.
// A same-origin worker is governed by its own response's CSP, so only this file may eval; the page
// and every other response stay without 'unsafe-eval'.
const KTX2_WORKER_PATH = '/ktx2-worker.js';
const KTX2_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'";

const HSTS = 'max-age=31536000; includeSubDomains';

const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

// Vite emits content-hashed bundles flat in assets/; models and textures copied from public/ live in
// subdirectories under stable names, so they must stay revalidatable.
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export function staticCacheControl(relPath: string): string {
  const file = relPath
    .split(sep)
    .join('/')
    .replace(/\.(br|gz)$/, '');
  if (HASHED_ASSET.test(file)) return 'public, max-age=31536000, immutable';
  if (file.startsWith('assets/') && file.indexOf('/', 'assets/'.length) !== -1) {
    return 'public, max-age=3600';
  }
  return 'no-cache';
}

function originOf(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
