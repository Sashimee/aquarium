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

Payments (optional): `STRIPE_SECRET_KEY` (`sk_` or `rk_`) and `STRIPE_WEBHOOK_SECRET` (`whsec_`) must be set both or
neither. Without them `/api/health` reports `payments: disabled` and the payment routes return 503. The webhook endpoint
is `https://<host>/api/payments/webhook`, subscribed to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice_payment.paid`,
`customer.subscription.created`/`updated`/`deleted`, `refund.created`/`updated`, and
`charge.dispute.closed`/`updated`/`funds_reinstated`. Test keys go on the devfish app only.
Before switching payments back on after a period off, look for subscriptions of deleted accounts that Stripe may
still bill: `select id from club_subscriptions where user_id is null and status in ('active','trialing','past_due','unpaid','incomplete')`.
Check each in the Stripe dashboard and cancel the ones still running (webhook retries lapse after three days, and an
`incomplete` row older than 24 h no longer blocks account deletion while payments are off). Subscriptions that sync again
after the switch are cancelled automatically.

Care reminders (T52): `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (base64url, set both or neither) turn on web push;
without them the server logs `web push is off` once at start and mail reminders keep working. `VAPID_SUBJECT`
(`mailto:` or `https:`, default `mailto:$MAIL_FROM`) and `REMINDER_DAILY_CAP` (global reminders per 24 h, default 500) are
optional. Generate a pair with:

```bash
node -e "const c=require('node:crypto');const k=c.generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.privateKey.export({format:'jwk'});const pub=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]);console.log('VAPID_PUBLIC_KEY='+pub.toString('base64url'));console.log('VAPID_PRIVATE_KEY='+j.d)"
```

Local copies of generated secrets live in `~/.config/aquarium/<env>.<name>` (mode 600):
`dev.db_password`, `dev.BETTER_AUTH_SECRET`, `prod.db_password`, `prod.BETTER_AUTH_SECRET`.
Generate new ones with `LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48`.

## Image

`Dockerfile` is multi-stage: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm deploy --prod` of the API,
then a `node:24-slim` runtime as the non-root `node` user on port 3000. `WEB_DIST` points at the built web
app; the API serves it with SPA fallback. The API is bundled to `apps/api/dist/server.js`. Migrations (`apps/api/drizzle`) run at start before listen; a failed
migration aborts start.

The `HEALTHCHECK` hits `/api/health`.

### Old chunks survive a deploy

`/assets/*` is served `immutable`, so tabs opened before a deploy still request the previous build's
hashed chunks. The image keeps its own `assets/` at `/app/assets-current`, and `docker/entrypoint.sh` copies
it into `/app/web/assets` at every start (only when that path is a mount point; unchanged files are touched,
changed ones are copied to a temp name and renamed, so a running container never sees a half-written file),
then deletes files not refreshed within `ASSET_RETENTION_DAYS` (default 7, exact to the minute). A
non-numeric value, one below 1 (`0` would prune the build just copied in), or one above 99999 (more than 5 digits after leading zeros) makes the container exit with an error at start. On the Aquarium Dev app, `/app/web/assets` is a Dokploy volume mount (`aquarium-dev-assets`),
so earlier builds' files are still there. Without the mount (prod, local, CI) the script does nothing and the
image's own `/app/web/assets` is served.

Create the mount only once the entrypoint is on the deployed branch: a mount over an image without the
copy step hides every asset. Dokploy API: `POST /api/mounts.create` with `type: "volume"`,
`volumeName: "aquarium-dev-assets"`, `mountPath: "/app/web/assets"`, `serviceId` set to the Dev app's `applicationId`,
`serviceType: "application"`, then redeploy. Never add it to Aquarium Prod without Alex's go.

## Indexing

When `SITE_INDEXABLE` is not exactly `true`, every response carries `X-Robots-Tag: noindex, nofollow` and
`robots.txt` disallows all. This fails closed: an unset or mistyped value means noindex.

## CI

`.github/workflows/ci.yml` runs on PRs into `dev` and pushes to `dev`: typecheck, lint, test (Postgres 18
service, `DATABASE_URL` provided), build, `assets:check`, and a Docker build that also waits for the
container to become healthy and checks the noindex header. The e2e shards do not run on PRs or pushes.
They run on demand only, once before a release: `gh workflow run ci.yml --ref dev`.

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
- **Prod backups are off, by decision.** The owner decided on 2026-10-15 that `aquarium-prod-db` has no
  backups, so Dokploy has no backup destination and no schedule. Losing the database or its volume loses all
  accounts and tanks. To turn backups on later: in Dokploy add a destination (S3-compatible bucket) under
  Settings, then on `aquarium-prod-db` (`UpLNHkjKBFMreruaR2aVW`) create a daily backup to it, run one backup
  and restore it into a scratch database to prove it works, and replace this note.
- **Postgres version:** CI and both Dokploy databases run `postgres:18`.

## Prod readiness (T23)

Aquarium Prod is configured but has never been deployed (status `idle`, no deployments), so
https://fish.bas.lu answers 502 until `main` is deployed. Its env has the same variable names as dev. Prod has
its own `BETTER_AUTH_SECRET` and database password (alphanumeric, copies in `~/.config/aquarium/prod.*`, mode
600), `APP_URL=https://fish.bas.lu` and `SITE_INDEXABLE=true`. The prod database has no public port.
