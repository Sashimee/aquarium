import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  revokeSessionRequestSchema,
  signUpRequestSchema,
  sessionListSchema,
  userSchema,
  type ApiError,
  type ErrorCode,
} from '@aquarium/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { AUTH_BASE_PATH, type Auth } from './auth.ts';
import { schema, type Database } from './db/index.ts';
import type { Mailer } from './mail.ts';

export interface AppOptions {
  indexable: boolean;
  webRoot: string;
  appOrigin: string;
  trustedProxies: string[];
  database: Database;
  auth: Auth;
  mailer: Mailer;
  logger?: boolean;
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
const BLOCKED_AUTH_PATHS = new Set([`${AUTH_BASE_PATH}/list-sessions`]);

function apiError(
  code: ErrorCode,
  message: string,
  issues?: ApiError['error']['issues'],
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
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

function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 && STATIC_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { indexable, webRoot, appOrigin, database, auth, mailer, logger = true } = opts;
  const app = Fastify({
    trustProxy: opts.trustedProxies,
    rewriteUrl: (req) => (req.url ?? '/').replace(/^\/{2,}/, '/'),
    logger: logger
      ? {
          serializers: {
            req: (req: FastifyRequest) => ({
              method: req.method,
              url: req.url.split('?')[0] ?? '',
            }),
          },
        }
      : false,
  });

  app.addHook('onSend', async (_req, reply) => {
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
          apiError(
            'validation_failed',
            status === 413 ? 'Body too large.' : 'Unsupported content type.',
          ),
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
        const pathname = normalizedPathname(req.url);
        if (BLOCKED_AUTH_PATHS.has(pathname)) {
          return reply.code(404).send(apiError('not_found', 'Not found.'));
        }
        const raw = typeof req.body === 'string' ? req.body : undefined;

        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/sign-up/email`) {
          signUpBodySchema.parse(parseJson(raw));
          const wait = mailer.consumeIp(req.ip);
          if (wait > 0) return tooMany(reply, wait);
        }
        if (req.method === 'POST' && pathname === `${AUTH_BASE_PATH}/send-verification-email`) {
          const wait = mailer.consumeIp(req.ip);
          if (wait > 0) return tooMany(reply, wait);
          const email = recipientOf(raw);
          const cooldown = email ? mailer.peekVerificationCooldown(email) : 0;
          if (cooldown > 0) return tooMany(reply, cooldown);
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
        const res = await auth.handler(request);

        reply.code(res.status);
        res.headers.forEach((value, name) => {
          if (name === 'set-cookie' || name === 'content-length' || name === 'transfer-encoding')
            return;
          reply.header(name, value);
        });
        const cookies = res.headers.getSetCookie();
        if (cookies.length > 0) reply.header('set-cookie', cookies);
        return reply.send(Buffer.from(await res.arrayBuffer()));
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

  const root = resolve(webRoot);
  const hasWeb = existsSync(resolve(root, 'index.html'));
  if (hasWeb) void app.register(fastifyStatic, { root, dotfiles: 'ignore' });

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

function originOf(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function recipientOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const body: unknown = JSON.parse(raw);
    const email = (body as { email?: unknown } | null)?.email;
    return typeof email === 'string' ? email : undefined;
  } catch {
    return undefined;
  }
}
