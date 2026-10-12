FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build
RUN mkdir -p apps/web/dist
RUN pnpm --filter @aquarium/api --prod deploy /out/api

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web
WORKDIR /app/api
COPY --from=build --chown=node:node /out/api /app/api
COPY --from=build --chown=node:node /repo/apps/web/dist /app/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
