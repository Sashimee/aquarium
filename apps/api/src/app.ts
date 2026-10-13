import { safeError } from './safe-error.ts';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  revokeSessionRequestSchema,
  signUpRequestSchema,
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
import { AUTH_BASE_PATH, type Auth } from './auth.ts';
import { createClock, type Clock } from './clock.ts';
import { schema, type Database } from './db/index.ts';
import { apiError } from './errors.ts';
import { loadCredits } from './credits.ts';
import { DEFAULT_LEGAL_LIMITS, registerLegalRoutes, type LegalLimits } from './legal.ts';
import type { IpAdmission, Mailer } from './mail.ts';
import { RateLimiter } from './rate-limit.ts';
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
  species: SpeciesCatalog;
  clock?: Clock;
  careLimits?: CareLimits;
  legalLimits?: LegalLimits;
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

const signUpBodySchema = signUpRequestSchema.extend({
  callbackURL: z.string().max(2048).optional(),
});

function parseJson(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? '');
  } catch {
    throw new ZodError([{ code: 'custom', path: [], message: 'Body must be valid JSON.' }]);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BLOCKED_AUTH_PATHS = new Set([
  `${AUTH_BASE_PATH}/list-sessions`,
  `${AUTH_BASE_PATH}/revoke-session`,
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

// Better Auth resolves the request through the WHATWG URL parser, which collapses dot segments
// (also percent-encoded) and treats a backslash as a slash. Path-based rules here compare a literal
// string, so any path the parser would rewrite is refused instead of being matched differently.
function hasAmbiguousPath(url: string): boolean {
  const raw = url.split('?')[0]?.split('#')[0] ?? '';
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

function normalizedPathname(url: string): string {
  const raw = url.split('?')[0] ?? '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return '/' + decoded.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

const TOKEN_PATH_PREFIXES = [`${AUTH_BASE_PATH}/reset-password/`, `${AUTH_BASE_PATH}/callback/`];
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9]{20,}$/;

export function redactUrl(url: string): string {
  const path = normalizedPathname(url);
  const lower = path.toLowerCase();
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

export function buildApp(opts: AppOptions): FastifyInstance {
  const { indexable, webRoot, appOrigin, database, auth, mailer, logger = true } = opts;
  const clock = opts.clock ?? createClock();
  const app = Fastify({
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

  const secure = new URL(appOrigin).protocol === 'https:';
  app.addHook('onSend', async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (secure) reply.header('strict-transport-security', HSTS);
    if (!indexable) reply.header('x-robots-tag', 'noindex, nofollow');
  });

  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || !normalizedPathname(req.url).startsWith('/api/')) return;
    if (!req.headers.cookie) return;
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
        const raw = typeof req.body === 'string' ? req.body : undefined;
        let admission: IpAdmission = { wait: 0, mailBlockedFor: 0 };

        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/sign-up/email`) {
          signUpBodySchema.parse(parseJson(raw));
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

        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || name === 'x-forwarded-for') continue;
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

        reply.code(res.status);
        res.headers.forEach((value, name) => {
          if (name === 'set-cookie' || name === 'content-length' || name === 'transfer-encoding')
            return;
          reply.header(name, value);
        });
        const cookies = res.headers.getSetCookie();
        if (cookies.length > 0) reply.header('set-cookie', cookies);
        const payload = Buffer.from(await res.arrayBuffer());
        const isJson = (res.headers.get('content-type') ?? '').toLowerCase().includes('json');
        if (!isJson || payload.length === 0) return reply.send(payload);
        return reply.send(JSON.stringify(stripTokens(JSON.parse(payload.toString('utf8')))));
      },
    });
  });

  async function currentSession(req: FastifyRequest) {
    return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  }

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

  registerTankRoutes({
    app,
    database,
    species: opts.species,
    clock,
    limiter,
    limits: opts.careLimits ?? DEFAULT_CARE_LIMITS,
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

// wasm-unsafe-eval: meshopt and basis transcoders. unsafe-eval: the basis transcoder is an emscripten
// embind module that calls new Function, and KTX2Loader runs it in a blob: worker, which inherits the
// document's policy (verified: without it every KTX2 load throws EvalError). worker-src blob: same loader. img-src blob: the account export download. style-src unsafe-inline: React style= attributes.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

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
