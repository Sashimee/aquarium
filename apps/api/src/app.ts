import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

export interface AppOptions {
  indexable: boolean;
  webRoot: string;
  logger?: boolean;
}

const HELLO_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aquarium</title></head>
<body><h1>Aquarium</h1><p>Coming soon.</p></body></html>`;

// TODO(backend-engineer): T06 replaces this placeholder; keep the noindex and health contract.
export function buildApp({ indexable, webRoot, logger = true }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: logger
      ? {
          serializers: {
            req: (req: FastifyRequest) => ({ method: req.method, url: req.url }),
          },
        }
      : false,
  });

  app.addHook('onSend', async (_req, reply) => {
    if (!indexable) reply.header('x-robots-tag', 'noindex, nofollow');
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain');
    return indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n';
  });

  const root = resolve(webRoot);
  const hasWeb = existsSync(resolve(root, 'index.html'));
  if (hasWeb) void app.register(fastifyStatic, { root, dotfiles: 'ignore' });

  app.setNotFoundHandler(async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '/';
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isApi || !isRead) return reply.code(404).send({ error: 'not_found' });
    if (extname(pathname) !== '') return reply.code(404).send('Not found');
    return hasWeb ? reply.sendFile('index.html') : reply.type('text/html').send(HELLO_PAGE);
  });

  return app;
}
