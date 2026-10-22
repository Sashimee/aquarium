FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json ./
# corepack gives no stable error text to tell network failures from a bad packageManager, so every failure is retried
RUN max=5; i=1; while [ $i -le $max ]; do pnpm --version && exit 0; [ $i -lt $max ] || break; echo "pnpm binary fetch failed (attempt $i), retrying" >&2; sleep $((i * 5)); i=$((i + 1)); done; echo "pnpm binary fetch failed after $max attempts" >&2; exit 1
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm build && pnpm --filter @aquarium/api compress:web
RUN mkdir -p apps/web/dist/assets /out/assets-current && cp -R apps/web/dist/assets/. /out/assets-current/
RUN pnpm --filter @aquarium/api --prod deploy /out/api

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/web
WORKDIR /app/api
COPY --from=build --chown=node:node /out/api /app/api
COPY --from=build --chown=node:node /repo/apps/web/dist /app/web
COPY --from=build --chown=node:node /out/assets-current /app/assets-current
COPY --chmod=755 docker/entrypoint.sh /app/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
