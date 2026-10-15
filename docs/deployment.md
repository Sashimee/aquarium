# Deployment

## Hosts

| | Dev | Prod |
|---|---|---|
| URL | https://devfish.bas.lu | https://fish.bas.lu |
| Branch | `dev` (Auto Deploy on) | `main` (Auto Deploy on; `main` moves only when Alex asks) |
| Dokploy app | Aquarium Dev, id `NqsCgoQZd3IdFZCrM5qiH` | Aquarium Prod, id `4MGSpE_itPqw9uAwwjzo5` |
| Postgres | aquarium-dev-db, id `PRoAGjcwopFyabvVVln-p`, host `aquarium-dev-db-12m3xp:5432` | aquarium-prod-db, id `UpLNHkjKBFMreruaR2aVW`, host `aquarium-prod-db-rhweoc:5432` |
| `SITE_INDEXABLE` | `false` | `true` |

Dokploy: https://dok.seil.pro, project **Bas.lu** (`69HxxeYa_TXw2mP8Z4IKG`), environment `production`
(`TaviC4t3K_Zg1Q-OBkLMW`). Both apps use GitHub provider _GitHub Alex_ (`Sashimee/aquarium`), a Dockerfile
build with context `/`, and a letsencrypt domain routed to port 3000. Databases have no public port.

API access: `https://dok.seil.pro/api` with header `x-api-key`, token in `~/.config/dokploy/seil.token`.
Never print the token or any env value.

## Environment variables

Set in the Dokploy app, never in the repo: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL`, `SMTP_HOST`,
`SMTP_PORT`, `MAIL_FROM` (must be `@bas.lu`), `SITE_INDEXABLE`, `NODE_ENV`. Optional: `TRUSTED_PROXIES` (comma-separated
IPs/CIDRs of the reverse proxy, default private ranges) so rate limits key on the real client IP.

Local copies of generated secrets live in `~/.config/aquarium/<env>.<name>` (mode 600):
`dev.db_password`, `dev.BETTER_AUTH_SECRET`, `prod.db_password`, `prod.BETTER_AUTH_SECRET`.
Generate new ones with `LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48`.

## Image

`Dockerfile` is multi-stage: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm deploy --prod` of the API,
then a `node:24-slim` runtime as the non-root `node` user on port 3000. `WEB_DIST` points at the built web
app; the API serves it with SPA fallback. The API is bundled to `apps/api/dist/server.js`. Migrations (`apps/api/drizzle`) run at start before listen; a failed
migration aborts start.

The `HEALTHCHECK` hits `/api/health`.

## Indexing

When `SITE_INDEXABLE` is not exactly `true`, every response carries `X-Robots-Tag: noindex, nofollow` and
`robots.txt` disallows all. This fails closed: an unset or mistyped value means noindex.

## CI

`.github/workflows/ci.yml` runs on PRs into `dev` and pushes to `dev`: typecheck, lint, test (Postgres 17
service, `DATABASE_URL` provided), build, `assets:check`, e2e, and a Docker build that also waits for the
container to become healthy and checks the noindex header. `assets:check` and `e2e` are skipped until their
scripts exist.

## Guard for `main`

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-push` refuses force-pushes and any push to `main` that is not a fast-forward to a commit
already merged into `origin/dev`.

## Verifying a deploy

```bash
curl -sI https://devfish.bas.lu/
curl -sI https://devfish.bas.lu/api/health
curl -s  https://devfish.bas.lu/robots.txt
```

## Alerts

- **Global mail cap reached.** The API logs one JSON line to stderr when the 200 mails/hour cap starts
  refusing mail (and again only after mail has flowed once more):
  `{"level":"error","event":"mail_global_cap_reached","msg":"global mail cap reached","limit":200,"windowSeconds":3600,"retryAfterSeconds":N}`.
  Match on `"event":"mail_global_cap_reached"`. While it holds, verification and reset mail is refused for
  everyone, which usually means about 20 IPs are spending their per-IP budget on sign-ups. Check the
  `aquarium-*` container logs in Dokploy, find the source IPs in the proxy log, and block them or lower
  `perIpSignup` in `apps/api/src/mail.ts`. The alert is not configured yet; setting it up is a Dokploy action.

## Troubleshooting traps

- **Failing healthcheck:** Traefik drops unhealthy containers and the host then answers 404 on the default
  certificate, with no error anywhere. A 404 on a fresh deploy means check the container health in Dokploy
  first, not the router.
- **`+`, `/`, `=` in env values:** Dokploy's env panel corrupts them. Secrets must be alphanumeric.
- **Mail alignment:** the OVH upstream authenticates as `info@bas.lu` and rejects misaligned senders
  asynchronously. `sendMail` succeeds and a 550 arrives later as a bounce. Verify delivery by reading a
  received test mail sent to an `@bas.lu` address. Never edit the shared relay's config.
- **Auto Deploy on Prod:** a push to `main` deploys immediately. Only Alex asks for `dev → main`.
- **Prod backups:** none yet. Dokploy has no backup destination configured (`destination.all` is empty), so
  no schedule exists for aquarium-prod-db. Once Alex picks a destination (S3-compatible bucket), create it in
  Dokploy, then add a daily backup on the prod database and a restore test, and record both here.
- **Postgres version:** both Dokploy databases run `postgres:18`; CI tests against `postgres:17`.

## Prod readiness (T23)

Aquarium Prod is configured but has never been deployed (status `idle`, no deployments), so
https://fish.bas.lu answers 502 until `main` is deployed. Its env has the same variable names as dev. Prod has
its own `BETTER_AUTH_SECRET` and database password (alphanumeric, copies in `~/.config/aquarium/prod.*`, mode
600), `APP_URL=https://fish.bas.lu` and `SITE_INDEXABLE=true`. The prod database has no public port.
