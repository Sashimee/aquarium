# Aquarium — master plan

A browser-based, full-3D, photorealistic aquarium. Fish move the way real fish move. You feed them,
play with them, decorate the tank, and they live or die by how you care for them. Accounts persist
your tanks across devices.

| | |
|---|---|
| Repo | `Sashimee/aquarium` — **private** |
| Dev | `https://devfish.bas.lu` ← branch `dev` · public, **noindex** |
| Prod | `https://fish.bas.lu` ← branch `main` · public, indexable |
| Hosting | Dokploy `https://dok.seil.pro` → project **Bas.lu** (`69HxxeYa_TXw2mP8Z4IKG`), env `production` |
| DNS | ✅ Done 2026-10-12: `fish.bas.lu` and `devfish.bas.lu` are A records pointing at `57.131.136.250` (OVH record ids 5441465277, 5441465279) |
| Mail | shared relay `mailrelay:587` on `dokploy-network`, no auth, sender `fish@bas.lu` |

## 1. Decisions (made with Alex, 2026-10-12)

| Topic | Decision |
|---|---|
| Fish assets | **Free only: CC0 or CC-BY (3.0/4.0).** No NC, no ND. CC-BY-SA only after asking. **Approved by Alex 2026-10-12 (#29):** CC-BY-SA reference photos for fallback textures by these authors only: Corydoras aeneus (Gabriel Resende Veiga / GABS), Gramma loreto (H. Zell / Llez), Pterapogon kauderni (David J. Stang); textures derived from them ship as CC-BY-SA with attribution. **Approved by Alex 2026-10-15:** the same for lateral photos of firefish (Nick Hobgood), six-line wrasse (Diego Delso), harlequin rasbora (Mariusz Dabrowski) and Ancistrus (Júlio Reis, Corydoras-adolfoi); derived textures ship as CC-BY-SA with attribution. Every CC-BY and CC-BY-SA asset is credited in-app at `/credits` and in `CREDITS.md`. |
| Biome | **Both, switchable**: planted freshwater and tropical reef. One user can own one of each, and the schema allows more later (superseded by §9.1 "Tanks per user"). |
| Gameplay | **Full sim plus persistence**: feeding, play, decorating, growth, water quality, and **fish can die** from realistic neglect or overfeeding. |
| Accounts | **User accounts**: passkeys first, plus email and password. Verification and reset mails go via `mailrelay` from `fish@bas.lu`. |
| Devices | **Desktop and mobile**: WebGPU with automatic WebGL2 fallback, and quality tiers chosen by measuring the GPU. **Minimum Safari 16**: the CSP uses `wasm-unsafe-eval`, which Safari 15 and older do not know, so meshopt and the basis transcoder would not compile there. The web build targets `es2022` + `safari16`, and `safari16` is also what keeps three loading on Safari 16.0 to 16.3: it makes the bundler lower class static blocks, which those versions cannot parse. Do not revert it to a bare `es2022`. |
| Dev access | `devfish.bas.lu` is public, `X-Robots-Tag: noindex` plus a `robots.txt` that disallows everything. |
| Dokploy | Both apps inside the existing **Bas.lu** project. |
| Merging | **Repo-local override of the global rule**: the orchestrator squash-merges feature PRs into `dev` once the `check` and `docker` jobs are green **and** `code-reviewer` approves. e2e runs only on demand, once before a release, and its failures are fixed in one batch then (Alex, 2026-10-19). `photo.spec` was dropped; photo mode stays covered by unit tests. `dev → main` happens **only when Alex asks**. |
| Concurrency | At most 8 running agents, reviewers included (Alex, 2026-10-19, see §9.1). |

## 2. Architecture

### 2.1 Monorepo (pnpm workspaces, Node 24, TypeScript strict)

```
apps/
  web/                Vite + TypeScript. Imperative three.js engine (WebGPURenderer + TSL), React UI shell
    src/engine/       renderer, quality tiers, post-processing, water and caustics, materials
    src/fish/         fish rendering: swim deformation (TSL), instancing, LOD
    src/scene/        tank presets (freshwater, reef), plants, hardscape, decor, colliders
    src/interaction/  input, camera, feeding tools, play tools, decorate mode
    src/ui/           React: HUD, auth, shop, tank switcher, credits, settings
    src/sync/         client ↔ API persistence and the offline-catch-up display
  api/                Fastify + Better Auth + Drizzle (Postgres) + nodemailer. In prod it also serves apps/web/dist
packages/
  sim/                PURE TS, no DOM, no three. Steering, schooling, species behaviours, food physics,
                      lifecycle (hunger, health, water chemistry, growth, death). Deterministic and seedable.
                      Runs in a Web Worker on the client; the lifecycle part runs on the server too.
  shared/             zod schemas = the API contract, species registry schema, shared constants
content/
  species/*.json      one file per species: behaviour, locomotion, render and lifecycle params (zod-validated)
  presets/*.json      tank presets: layout and decor placement
tools/asset-pipeline/ gltf-transform scripts: normalise → fin mask → LOD → meshopt → KTX2 → manifest
apps/web/public/assets/  ONLY processed, optimised assets are committed. Raw downloads never are.
e2e/                  Playwright
```

**Why imperative three.js and not R3F:** the frame loop, instancing and the worker hand-off need
direct control, and React re-render semantics would only get in the way there. React owns the UI
overlay only. The engine exposes a small typed event bus to the UI.

**Versions:** Phase 0 pins exact current versions of `three`, `better-auth`, `drizzle-orm`,
`fastify`, `vite`, `react` and `@gltf-transform/*`. Agents must read the **installed** package source
and types for an API before using it. In particular, three's `WebGPURenderer` and TSL change
between releases, so never write them from memory.

### 2.2 Rendering — where the photorealism comes from

Free fish models vary in quality, so most of the realism has to come from the renderer.

- **Renderer:** `three/webgpu` `WebGPURenderer` with forced-WebGL2 fallback, and all custom shading in **TSL** so one source serves both backends. Tone mapping is AgX, output is sRGB, and HDR IBL comes from a CC0 Poly Haven HDRI.
- **Water volume:** spectral absorption in the fragment stage (red is lost first, so the blue-green shift grows with distance), in-scattering fog, and suspended particulates ("marine snow") drifting with the current field.
- **Caustics:** animated caustics projected from the surface onto the substrate, decor and fish (procedural TSL caustics, or a tiled caustic texture on the low tier).
- **Light shafts:** screen-space volumetric god rays from the hood light. Disabled on the low tier.
- **Surface from below:** Snell's window, total internal reflection outside the window, and a gently moving normal-mapped surface.
- **Glass:** visible tank glass with Fresnel reflections, a subtle green edge tint, and refraction offset when viewed from outside. Outside view is the default; "dive" mode puts the camera inside.
- **Fish materials:** `MeshPhysicalNodeMaterial` with clearcoat (wet sheen), **iridescence** (neon tetra stripe, scales), thin-surface **transmission** on fins, and an approximate subsurface term for back-lit fins. A colour-condition uniform drives stress or sickness paling and night paling (real neon tetras fade at night).
- **Post:** TAA (high tier) or SMAA, subtle bloom on highlights, depth-of-field in focus mode, film grain off by default.
- **Bubbles:** air-stone column (instanced, rising with wobble, bursting at the surface) and occasional fish-gulp bubbles.
- **Day/night:** light colour temperature and intensity follow the tank's local clock, with a moonlight mode and fish resting at night.

**Quality tiers** (`low` / `medium` / `high` / `ultra`): chosen at start by a 2-second GPU timing probe, then
adapted from the rolling frame time with hysteresis. Each tier sets resolution scale, shadow map size,
post chain, caustic method, particle counts, fish LOD distances, plant density and texture size
(1k/2k KTX2).

### 2.3 Fish movement — "correct movement"

Behaviour (`packages/sim`, fixed 30 Hz step in a worker, interpolated at render rate):

- **Steering core:** Reynolds steering with mass and turn-rate limits per species, velocity-dependent banking, pitch limits (fish rarely swim vertically), and a preferred depth band.
- **Schooling:** boids using **topological neighbours** (k ≈ 6–7 nearest, after Ballerini et al., 2008) rather than a metric radius. Tetras and rasboras school tightly, and tighten further when startled.
- **Burst-and-coast** for small schooling fish; continuous cruising for tangs; **labriform** (pectoral-driven) hovering for angelfish, discus and wrasse; corydoras forage on the bottom, sift the substrate and occasionally **dart to the surface to gulp air** (real behaviour); bristlenose pleco or otocinclus graze on glass and decor surfaces.
- **Species-specific:** betta territoriality and flaring; clownfish hosting their anemone; tangs grazing the rock; angelfish holding a mid-water station; royal gramma sheltering in caves.
- **Avoidance:** a signed distance field of the tank walls plus decor colliders (rocks and driftwood are hard; plants are soft and push aside). Fish never interpenetrate geometry.
- **Startle (C-start):** a glass tap or a fast pointer near a fish triggers a fast-start escape (about 30 ms bend then burst). Responses spread through the school with latency.
- **Feeding AI:** perception cone and range per species, food salience, competition (dominant fish push in), satiation reduces interest, and bottom feeders wait for sinking food.
- **Curiosity/play:** some species follow a slow-moving finger or laser dot, lose interest over time, and come to the surface spot where you usually feed (learned feeding-spot memory).

Locomotion kinematics (`apps/web/src/fish`, TSL vertex stage):

- **Procedural spine wave.** Most free models are unrigged, so swimming is a travelling body wave in the vertex shader along the normalised body axis (+Z forward). Amplitude envelope per swimming mode: carangiform (tetra, tang: rear third), subcarangiform (angelfish), with stiff heads.
- **Tail-beat frequency** comes from speed via the Strouhal number (St ≈ 0.3): `f = St · U / A`. Turns add an asymmetric bend.
- **Fins:** a per-vertex fin mask (baked by the asset pipeline) drives pectoral flutter, dorsal and anal undulation and caudal lag, layered on the body wave.
- **Gill and mouth** micro-motion on the high tier.
- Schools are drawn with **InstancedMesh**, with per-instance phase, speed and colour variation in instance attributes. Each species has its own LOD chain (high, mid, impostor).

### 2.4 Life simulation (persistence, with death)

The lifecycle model lives in `packages/sim/lifecycle` as **pure functions**. The **server is
authoritative** and the client shows predictions from the same code. Every rate lives in
`content/species/*.json` and is tunable without code changes.

- **Fish:** `hunger` 0..1 rises at a species rate. `health` 0..1 falls while hunger > 0.75 or toxicity is above the species tolerance, and recovers slowly otherwise. `size` grows with good-health age up to the species max. Death happens at `health = 0`.
- **Water:** `ammonia` rises from bioload (fish mass) and from **uneaten food** that decays after N minutes; the filter removes it at a rate. `nitrate` builds slowly and is reset by water changes. Overfeeding therefore poisons the tank, which is the realistic failure.
- **Care actions:** feed (choose food type), partial water change (−50% nitrate and ammonia), gravel vacuum (removes decaying food), algae scrape. Algae grows on the glass over time as a visible shader layer.
- **Tuning target (set before balancing):** one visit a day keeps a tank healthy; about 4 days without food starts real harm; about 7–10 days kills small fish. A brand-new account gets a 48 h grace period. **A "vacation feeder" decor item** slows hunger by 50% while placed.
- **Offline catch-up:** on load the server steps the lifecycle from `last_tick_at` to now at 10-minute resolution, capped at 60 days, then persists the result. The client shows a "while you were away" summary that includes deaths.
- **Death presentation:** the fish swims erratically, then floats belly-up at the surface. The user removes it with the net tool, and it is recorded in a small memorial list on the tank.
- **Feeding validation:** the client simulates eating and reports `ate(fishId, portion)` events in batches. The server rejects consumption larger than the food dropped in that window, and rate-limits feeding.
- **New fish:** free "shop" limited by tank capacity (bioload). New fish arrive in a bag that floats for acclimation, then are released. *(Superseded by the Pearl economy in §9.1/§9.2, T69–T72: fish and items cost Pearls; basic care stays free.)*

### 2.5 Interaction and play

- **Camera:** orbit outside the glass (default), pinch and scroll zoom, a focus-follow mode on a tapped fish (shows name, species and stats), and an inside "dive" camera.
- **Feeding:** flakes float, drift, then sink slowly; pellets sink fast; bloodworms (freshwater); brine shrimp and nori clip (reef); algae wafer for bottom feeders. Food particles use real drag and buoyancy, are pushed by the filter current, and settle on the substrate where they decay.
- **Play:** glass tap (startle, with a ripple on the glass), finger or laser dot (curious species follow), hand-feed (hold food at the surface), and a bubble wand.
- **Decorate mode:** drag rocks, driftwood, plants and ornaments; they snap onto the substrate with physics-plausible settling. Colliders and the SDF update live, and the layout is saved.
- **Tank switcher:** freshwater ⇄ reef.
- **Accessibility:** UI is keyboard reachable, honours reduced motion (slower camera, no shake) and has readable contrast. The 3D view gets a text "tank report" alternative.

### 2.6 Backend and data

- **Fastify** on `:3000` in one container. `/api/*` is the API and everything else is `apps/web/dist` (SPA fallback).
- **Better Auth:** email+password (verification mail required before saving a tank) plus the **passkey** plugin, with Drizzle adapter, session cookies `HttpOnly; Secure; SameSite=Lax`, and CSRF protection on mutations.
- **Mail:** nodemailer to `mailrelay:587` with no auth, `From: Aquarium <fish@bas.lu>`. The relay is a **live shared service, so never edit its config.** The OVH upstream authenticates as `info@bas.lu` and rejects misaligned senders **asynchronously**: a 550 arrives later as a bounce, after `sendMail` has already succeeded. Verify delivery end to end by reading a received test mail sent to an `@bas.lu` address. Rate-limit outgoing mail per IP and per recipient so the signup form can't be used to spam.
- **Tables (Drizzle):** Better Auth's own tables, plus `tanks` (owner, biome, name, decor_layout jsonb, water jsonb, last_tick_at), `fish` (tank, species, name, born_at, size, hunger, health, status, died_at, cause), `events` (append-only care log, trimmed after 90 d), `memorials`.
- **Migrations:** drizzle-kit, run at container start before listen. If they fail, start fails loudly.
- **GDPR (EU host, real emails):** account deletion that cascades, JSON data export, a privacy page, essential cookies only, and no analytics.
- **Health:** `/api/health` checks the DB. It is the container healthcheck: Traefik drops unhealthy containers and the host then 404s with no error anywhere.

### 2.7 Budgets (enforced by `visual-perf-auditor`)

| | Desktop (high) | Mobile (medium/low) |
|---|---|---|
| Frame rate | 60 fps at 1440p, mid GPU (RTX 3060 / M1) | ≥ 30 fps on iPhone 12 / Pixel 7 class |
| First interactive tank | ≤ 4 s on a good connection | ≤ 6 s on 4G |
| Initial download | ≤ 40 MB (more streamed after) | ≤ 15 MB |
| Draw calls | ≤ 300 | ≤ 150 |
| Fish per tank | up to 60 | up to 30 |
| JS (gzip, initial) | ≤ 450 KB | same |

## 3. Assets — free only

**Sources, in order of preference:** Smithsonian 3D / Open Access (CC0 specimen scans), Sketchfab
downloadable models filtered to CC0 or CC-BY, Poly Haven (CC0: HDRIs, rocks, driftwood, textures),
ambientCG (CC0 PBR textures), and Wikimedia Commons CC0 or CC-BY photos (used as texture reference or
projection for procedural fallbacks). Quaternius and Kenney (CC0) are only a last resort, because
they are stylised.

**Roster:**

| Freshwater (MVP ★) | Reef (MVP ★) |
|---|---|
| ★ Neon tetra (school 12–20) | ★ Ocellaris clownfish (pair, with anemone) |
| ★ Angelfish | ★ Blue tang |
| ★ Bronze corydoras (group 4–6) | ★ Yellow tang |
| ★ Betta (single, territorial) | ★ Royal gramma |
| ★ Guppy | ★ Banggai cardinalfish |
| Discus, harlequin rasbora, bristlenose pleco, cherry shrimp | Six-line wrasse, firefish, cleaner shrimp |

**Fallback when no acceptable free model exists:** procedural loft (cross-sections along the
spine from species proportions) with a texture projected from a CC0 or CC-BY reference photo. The
curator records which species use the fallback, and the auditor judges them.

**Rules:** raw downloads go to `~/.cache/aquarium-assets/raw/<asset-id>/` (outside the repo,
untrusted, never executed). `assets/manifest.json` records source URL, author, licence, licence
URL, sha256 and the modifications made. Only processed `.glb`/`.ktx2` files are committed under
`apps/web/public/assets/` (target total < 150 MB; no Git LFS). The build fails if an asset is
missing from the manifest or carries a licence outside CC0 / CC-BY, except CC-BY-SA entries covered by an Alex approval recorded in §1 and in the manifest `rules`.

## 4. Delivery: tasks, owners, dependencies, waves

Each task becomes a GitHub issue (labels `wave:N`, `agent:<name>`), one branch, one PR into `dev`.
Branch names are `feat/<issue>-<slug>`. Every PR must pass the `check` and `docker` jobs and `code-reviewer` before the
orchestrator merges it. A task is *ready* once all of its dependencies are **merged into dev**.

| ID | Task | Agent | Depends on | Wave |
|---|---|---|---|---|
| T00 | Bootstrap: git, pnpm monorepo skeleton, tsconfig, eslint/prettier, vitest, `.githooks/pre-push`, private repo, `dev` branch, labels, all issues | orchestrator (inline) | — | 0 |
| T01 | `packages/shared`: zod API contract v0 (auth, tank, fish, events) + species schema | backend-engineer | T00 | 0 |
| T02 | Dockerfile, CI (typecheck, lint, test, build, image build), Dokploy apps + Postgres ×2 + domains + env, noindex on dev, hello page live on devfish | devops-engineer | T00 | 1 |
| T03 | Engine core: WebGPURenderer + fallback, tank glass box, water volume and absorption, caustics, IBL, tone mapping, **quality-tier system**, dev-only tweak panel | render-engineer | T00 | 1 |
| T04 | `packages/sim` core: fixed step, seedable RNG, steering, topological boids, tank SDF, worker bridge, headless benchmark | fish-behavior-engineer | T01 | 1 |
| T05 | Asset sourcing: candidates for every MVP species + plants + hardscape + HDRI, licence verification, manifest, `CREDITS.md`, fallback list | asset-curator | T00 | 1 |
| T06 | API: Fastify, Better Auth (email+password+passkey), Drizzle schema + migrations, mail via relay, `/api/health`, rate limits, tests on real Postgres | backend-engineer | T01 | 1 |
| T07 | Web shell: React UI frame, routing, auth screens on the contract, input abstraction (pointer and touch), camera controller (orbit, focus, dive) | gameplay-engineer | T01, T03 | 2 |
| T08 | Asset pipeline: normalise axis/scale/pivot, fin-mask bake, LOD chain, meshopt, KTX2, manifest check in CI | asset-pipeline-engineer | T05 | 2 |
| T09 | Fish rendering: physical fish material, TSL spine wave + fins + Strouhal coupling, instanced schools, LOD | render-engineer | T03, T04, T08 | 3 |
| T10 | Species behaviours: schooling variants, burst-coast, labriform, bottom foraging + air gulp, glass grazing, territoriality, startle cascade, day/night rest, decor collider avoidance | fish-behavior-engineer | T04 | 2 |
| T11 | Freshwater preset: substrate, hardscape, instanced plants with current sway, colliders, layout JSON | scene-builder | T03, T08 | 3 |
| T12 | Lifecycle model in `packages/sim/lifecycle` + server authority: tanks/fish API, offline catch-up, feeding validation, death, grace period | backend-engineer | T04, T06 | 2 |
| T13 | Feeding and play: food particle physics, feeding AI hook-up, glass tap, finger/laser, hand-feed, bubble wand | gameplay-engineer | T07, T10 | 3 |
| T14 | Reef preset: live-rock hardscape, corals, animated anemone + hosting anchor, reef lighting | scene-builder | T11 | 4 |
| T15 | Render polish: Snell's window, bubbles, particulates, god rays, DOF, TAA/SMAA, glass Fresnel, iridescence tuning, algae layer, night mode | render-engineer | T09, T11 | 4 |
| T16 | Persistence and care UI: client sync, "while you were away", care actions, shop + acclimation bag, death and net and memorial, tank switcher, naming | gameplay-engineer | T12, T13 | 4 |
| T17 | Decorate mode: drag/place/settle decor, live collider/SDF update, save layout, vacation feeder | gameplay-engineer | T11, T16 | 5 |
| T18 | Audit pass 1: realism vs reference photos, perf on desktop + mobile emulation, budgets → issues | visual-perf-auditor | T14, T15, T16 | 5 |
| T19 | E2E: signup/verify/login/passkey (virtual authenticator), feed, care, death catch-up (time-travelled), decorate, tank switch; WebGL2 path in CI | gameplay-engineer | T16, T17 | 6 |
| T20 | GDPR + legal: account deletion, export, privacy page, `/credits` page from manifest | backend-engineer | T12, T05 | 3 |
| T21 | Security review of auth, rate limits, mail abuse, CSRF, headers (CSP for WebGPU/workers) | code-reviewer | T16, T20 | 5 |
| T22 | Fix wave from T18/T21 issues (fanned out to owners) | owners | T18, T21 | 6 |
| T23 | Release candidate on devfish: full checks, prod Postgres backup schedule, prod env, `CHANGELOG`, then **stop and ask Alex** for `dev → main` (superseded: the release waits for T68, §9) | devops-engineer | T19, T22 | 7 |
| T24 | Extended roster: discus, rasbora, pleco, shrimp, wrasse, firefish, cleaner shrimp | curator → pipeline → behaviour → render | T22 | 8 |

### Concurrency map

```
Wave 0  ┃ T00 (inline) ─► T01 ──────────────────────────────────────────────────────
Wave 1  ┃ T02 devops │ T03 render │ T04 behaviour │ T05 curator │ T06 backend │ (slot: code-reviewer)
Wave 2  ┃ T07 gameplay │ T08 pipeline │ T10 behaviour │ T12 backend │ reviewers
Wave 3  ┃ T09 render │ T11 scene │ T13 gameplay │ T20 backend │ reviewers
Wave 4  ┃ T14 scene │ T15 render │ T16 gameplay │ reviewers
Wave 5  ┃ T17 gameplay │ T18 auditor │ T21 code-reviewer
Wave 6  ┃ T19 gameplay │ T22 fixes (≤ 4 owners)
Wave 7  ┃ T23 devops → STOP, ask Alex for prod
Wave 8  ┃ T24 roster expansion (pipelined per species)
```

Waves are not barriers. The orchestrator starts **any** task as soon as its dependencies are
merged, with at most 8 running agents, reviewers included (§9.1). The wave column only shows the earliest a task can
start.

**Conflict avoidance:** each agent owns directories (see its agent file). Shared files
(`packages/shared`, `content/species/*.json`, root `package.json`) change only through small PRs
that are reviewed and merged fast. An agent that needs a contract change opens that PR first.

## 5. Environments and deployment

| | Dev | Prod |
|---|---|---|
| Dokploy app | **Aquarium Dev** (Dockerfile build, context `/`) | **Aquarium Prod** |
| Branch / Auto Deploy | `dev` / on | `main` / on (main only moves when Alex asks) |
| Domain | `devfish.bas.lu`, HTTPS, letsencrypt, port 3000 | `fish.bas.lu` |
| DB | Dokploy Postgres **aquarium-dev-db** | **aquarium-prod-db** + scheduled backups |
| `SITE_INDEXABLE` | `false` → `X-Robots-Tag: noindex, nofollow` on every response + `robots.txt` disallows all | `true` |
| `APP_URL` | `https://devfish.bas.lu` | `https://fish.bas.lu` |

Env vars (set in Dokploy, never in the repo; local copies at `~/.config/aquarium/`, mode 600):
`DATABASE_URL`, `BETTER_AUTH_SECRET` (**alphanumeric only**: Dokploy's env panel corrupts `+/=`;
generate with `LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48`), `APP_URL`, `SMTP_HOST=mailrelay`,
`SMTP_PORT=587`, `MAIL_FROM=fish@bas.lu`, `SITE_INDEXABLE`, `NODE_ENV=production`; from §9: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (test-mode keys on devfish only; these keep their provider format, see §9.1).

Dokploy API: `https://dok.seil.pro/api`, header `x-api-key`, token read from
`~/.config/dokploy/seil.token`. Never print the token or any env value. GitHub provider: *GitHub Alex*.

**Main protection:** this is a private repo on a free GitHub plan, so there is no branch protection.
`.githooks/pre-push` refuses pushes to `main` that aren't fast-forwards from a merged `dev` PR, and
refuses all force-pushes. Set it up with `git config core.hooksPath .githooks`.

## 6. Quality gates

`pnpm typecheck` · `pnpm lint` · `pnpm test` (vitest: sim and lifecycle deterministic tests, API
tests against real Postgres in CI) · `pnpm build` · `pnpm assets:check` (licences and manifest) ·
Docker image builds. Every PR must pass the `check` and `docker` jobs.

Release gate (on demand, once after all planned work is merged and before the `dev → main` ask):
`pnpm e2e` (Playwright, WebGL2 path; WebGPU path run locally where a GPU exists), triggered with
`gh workflow run ci.yml --ref dev`.

## 7. Risks

| Risk | Mitigation |
|---|---|
| No good free model for some species | Procedural loft + photo projection fallback; the auditor judges; T24 can replace models later |
| WebGPU absent in CI and headless | Test the WebGL2 path in CI; the TSL single source keeps both paths identical |
| Mobile thermal throttling | Adaptive tiers with hysteresis; a 30 fps cap option |
| Free-licence attribution mistakes | Manifest is mandatory, the CI check fails the build, `/credits` is generated from the manifest |
| Mail bounces arriving asynchronously | `fish@bas.lu` stays on the `bas.lu` domain; delivery verified by reading an actual received mail |
| Signup used to spam via the shared relay | Per-IP and per-recipient rate limits, verification-mail cooldown |
| Death mechanic feels punishing | 48 h grace, vacation feeder, tunable rates, a "while you were away" warning before deaths when possible |
| Merge conflicts at high concurrency | Directory ownership, contract-first PRs, fast review and merge of shared-file PRs |
| Repo bloat from assets | Only processed assets committed, budget < 150 MB enforced by `assets:check` |

## 8. Open items for later (not blocking)

- Prod DB backup destination (Dokploy S3 target?). Ask at T23.
- Reminder emails: now in scope as opt-in (§9, T52).

## 9. Expansion (asked by Alex 2026-10-16, #612)

Alex asked for every proposed extra feature to be built, and for a choice of **5 tank background
pictures per tank type**. The release (`dev → main`) waits until every task in this section is
done (T68); Alex confirmed on 2026-10-19 that there is no release before that.

### 9.1 Decisions

| Topic | Decision |
|---|---|
| Tank backgrounds | 5 per biome (10 at launch, 5 more per new biome). They look like the printed posters stuck to a real tank's back glass. The choice is saved per tank on the server and changed from decorate mode. CC0 / CC-BY photos, or renders made in the pipeline from CC0 assets. |
| New tanks and cycling | A new tank comes with a seeded filter, so it starts cycled and one visit a day keeps it healthy (§2.4, §7). The nitrogen cycle only bites when bioload jumps (many fish added at once) or filter media is rinsed in tap water, and then it shows as rising ammonia that the player can see and fix over days, not an instant kill. Existing tanks migrate as cycled. |
| Tank size and chemistry | Nanos are harsher than larger tanks, for waste and for overfeeding, both mildly (Alex, 2026-10-19, #743). Fish waste concentrates as (300 L / litres)^0.7, so a full nano declines faster than a full 300 L tank (a full 200 L declines slightly slower than a full 300 L, 5.08 against 4.91 days, so the order is not strictly monotonic above the nano), and uneaten food scales as (300 L / litres)^0.25, so one portion adds about 1.8x the ammonia in 30 L as in 300 L. From clean water one portion never reaches the lowest species ammonia tolerance (0.09) in a nano; on a stocked nano already on 0.5 portions a day, one extra portion takes peak ammonia to about 0.175 and costs up to about 13% health (cleaner shrimp, the most sensitive), but no single feed kills. |
| Fish cap | Every tank has a cap on animals (fish, fry, invertebrates): nano 30 L → 12; the standard tank, 200 L and long 300 L → 60, today's `MAX_FISH_PER_TANK` (§2.7 desktop). At the cap no fry are born (eggs are eaten), and the shop and gifts refuse more animals. A tank that is over its cap (e.g. a standard tank moved to nano) keeps every animal; only additions are blocked until it drops below. On mobile tiers the 30 nearest animals render as full meshes and the rest as impostors (#608), which keeps the §2.7 mobile budget; T66 measures it. |
| Social features | Public links, reactions, gallery and gifts are opt-in per tank, private by default. No free-text chat. A tank name or handle shown publicly passes a word filter. No email or account identity is ever shown. |
| Reminder mail | Opt-in only, off by default, at most one a day per user, a global daily cap on the shared relay, and RFC 8058 one-click unsubscribe. Supersedes the §8 open item. Test mail goes to `@bas.lu` only. |
| Web push | Through the PWA (iOS 16.4+ needs it installed to the home screen). VAPID keys live in Dokploy env. They are base64url, which is an accepted exception to the alphanumeric rule (no characters Dokploy's env panel mangles). |
| Haptics | The Vibration API where it exists (Android). iOS Safari has none, so iOS gets no haptics; no workaround hacks. |
| Sound | Off until the first user gesture, a master volume, a mute button and a separate "no sudden loud sounds" setting. AAC in `.m4a`, which every Safari since 16 and every other target browser plays. CC0 / CC-BY audio in the manifest. |
| New biomes | African cichlid lake, Amazon blackwater, brackish mangrove. Each one is a preset, 5 backgrounds and at least 4 species. The biome enum in `packages/shared` grows in T30. |
| Tanks per user | Replaces §1's "one of each": a user may own up to 6 display tanks, any mix of biomes and sizes, plus one quarantine tank (nano, not counted in the 6). Confirmed by Alex 2026-10-19. |
| Window weather | Simulated from the tank's seed and the local clock. No location, no third-party weather API. |
| Budgets | §2.7 and the < 150 MB repo asset budget (§3) stay. Backgrounds, audio, new species and biomes stream per preset. If the budget can't hold a new biome, the orchestrator stops and asks Alex before raising it. |
| Agent concurrency | At most 8 running agents, reviewers included (`CLAUDE.md` loop step 4). Alex lifted the cap on 2026-10-19, restored 6 the same day after 21 parallel agents pushed the load average to 110 and filled RAM, then raised it to 8 with agents leaving Playwright e2e to CI. |
| e2e timing | Playwright no longer runs on PRs, batch branches or `dev` pushes. It runs on demand, once after all planned work is merged and before the `dev → main` ask, and failures are fixed in one batch then. `photo.spec` was deleted; #760 closed (Alex, 2026-10-19). |
| Juvenile or adult | Alex, 2026-10-19: the shop sells every species as a juvenile or an adult, at two prices. A juvenile is smaller, cheaper, and grows into an adult over the species' `juvenileAfterDays → adultAfterDays` (T33). An adult costs about 2.5× as much and arrives at full size and colour. |
| Heaters | Alex, 2026-10-19: warm-water species need a heater. Without one, the tank drifts to room temperature (21 °C), and a species whose range starts above that is stressed and can get sick (T37). New tanks come with a basic heater. Existing tanks migrate with one installed so no current fish suffers. The shop warns before a warm species goes into a tank without a heater, but does not block it. |
| In-game currency | One currency, **Pearls**, earned by playing and bought with real money. Every shop item has a price in Pearls, and the balance is always visible in the HUD. Basic care is never charged and never blocked by the balance: feeding with the standard food, water changes, gravel vacuum, algae scrape and the standard treatment for each disease are free, so no fish dies because the player did not pay, even with a negative balance after a chargeback. Pearls buy fish, plants, decor, equipment upgrades, premium foods, backgrounds, rooms and tank slots and sizes. There is no consumable inventory for basic care. No loot boxes and no random paid rewards. Every price lives in `content/economy.json`, so tuning prices is a data change. |
| Real-money packs | Pearl packs at App Store price points, VAT included: €0.99 → 100, €4.99 → 550, €9.99 → 1 200, €19.99 → 2 500, €49.99 → 6 500, €99.99 → 14 000. Plus an optional "Aquarist Club" subscription at €4.99 a month: 20 Pearls a day and cosmetic extras. On the web, payments go through Stripe Checkout. In a future iOS app, they go through Apple in-app purchase at the same price points. Following the EU consumer-protection principles for virtual currencies (CPC 2024): packs show their real price, every shop item also shows its approximate euro value next to the Pearl price, a purchase never forces a large pack to cover a small shortfall (the not-enough-Pearls flow offers the smallest pack that covers it, and shows the leftover), there are no countdowns, limited-time pressure or purchase prompts mid-care, and no purchase prompts are aimed at children (buying needs an adult confirmation in the account settings). Checkout asks for explicit consent to immediate delivery **and** acknowledgement that this loses the 14-day withdrawal right; the receipt mail confirms both. The subscription can be cancelled in one step from the settings screen. Devfish runs in Stripe test mode only. **Live payments wait for Alex**: business permit, VAT/OSS registration, Stripe account and terms of sale. |
| Rooms | Alex, 2026-10-23: every tank stands in a room you can see around it and through the front glass. 12 rooms. **Free:** living room and bedroom. **Bought with Pearls** (500–1 500 each, one purchase unlocks the room for all of the player's tanks): aquarium shop, home office, city loft, Japanese zen room, beach house, mountain cabin, sushi restaurant, castle library, public aquarium hall, submarine. The room is chosen per tank in decorate mode, and "no room" (T57's plain studio) stays as a free setting for players who want it or for slow devices. New and existing tanks start in the living room. T57's home office was free, so every account created before T75 deploys is granted the home office once (a `grant` ledger row of 0 Pearls); accounts after that buy it. T57's per-device room setting (`aquarium.room` in local storage) is migrated once by T78: only an explicitly stored value counts (`living-room` → `room-living`, `office` → `room-office`, `none` → no room; an absent key leaves the living room). It applies only to tanks still on the default living room that the player has never set, and only if the owner owns that room; then the key is removed, so a second device can't overwrite a room chosen since. Each room has its own furniture, light, window or view, and ambience, and replaces T57's two backdrops. The window weather and time of day from T57 carry over to every room that has a window. The community tank (T64) always stands in the public aquarium hall, free for everyone who sees it. Rooms stream one at a time and stay within §2.7 and the §3 asset budget (see §9.2), or the orchestrator asks Alex first (as for biomes). |
| Revenue target | Alex asked for €10k profit a month. Each euro a player spends keeps €0.73 after 17 % Luxembourg VAT and Apple's 15 % (Small Business Program), or about €0.81 on the web through Stripe for Luxembourg buyers. Web sales to other EU countries carry the buyer's country VAT through OSS (17–27 %), and Stripe's fixed fee (about €0.25 plus 1.5 % for EU cards) takes about a quarter of the €0.99 pack, so the web shop starts at the €4.99 pack. €10k profit before income tax therefore needs about €13.8k of player spending a month. €10k in pocket after Luxembourg income tax and social contributions needs roughly €27.5k. These are estimates for a fiduciaire to confirm. With 100 users (Alex's planning figure, not a measured base) that is €138–275 per user per month, about 50–100 times what casual sim games earn (ARPU €1–4 a month). Prices are therefore set at market level, and the target comes from players: about 3 500–14 000 monthly active players for €10k before tax. |

### 9.2 Architecture notes

- **Backgrounds:** `packages/shared` adds `tank.backgroundId` (an enum per biome, from `content/backgrounds/*.json`) and `PATCH /api/tanks/:id` stores it (T25). The renderer draws it as a lit, slightly defocused plane just behind the back glass. Seen from the front, the camera ray crosses the whole water column before it reaches the poster, so the poster is tinted exactly once by water absorption, like everything else seen through the tank. The poster's back is opaque black film, as on a real tank, which is what the orbit camera shows from behind. KTX2, one size per tier: 2048×1024 high, 1024×512 mid and mobile, 512×256 low, ≤ 600 KB at the largest.
- **Water chemistry v2 (lifecycle):** ammonia → nitrite → nitrate through two bacteria colonies that grow on filter media (the nitrogen cycle). Plus pH, KH, temperature and salinity (brackish and reef). A new tank's filter is seeded (§9.1). "Bottled bacteria" in the shop speeds recovery after a crash. Every rate lives in `content/species` and a new `content/chemistry.json`.
- **Breeding:** species JSON gains `breeding` (mode: livebearer | egg-scatterer | substrate-spawner | mouthbrooder | none; conditions; brood size; fry growth). The server decides births inside the lifecycle step. Fry are fish with `stage: fry | juvenile | adult`. The tank fish cap (§9.1) is enforced there.
- **Tank sizes:** `packages/shared` adds `tank.size: nano30 | standard | std200 | long300` (`standard` is today's tank, the default) with its dimensions and cap. The sim bounds, the avoidance SDF, the preset layout, the glass and water volume and the size picker all read it.
- **Personality:** per-fish seeded traits `boldness`, `greed`, `sociability` (0..1). They are stored server-side and feed the steering weights in `packages/sim`. "Recognises you": fish approach the front glass when you've visited often.
- **Disease:** ich, fin rot and velvet, each with a trigger (stress from bad water, temperature swings, a new fish without quarantine), visible symptoms (a TSL overlay: white spots, frayed fin mask, gold dust) and a treatment (medicine dose, temperature, quarantine tank).
- **Equipment:** filter, heater, light (schedule + intensity), CO₂ (freshwater) and wave maker (reef). Each piece has tiers with lifecycle effects. The wave maker feeds the sim's current field and the coral and plant sway.
- **PWA:** the service worker caches only the app shell and `/assets/**`. It never caches `/api/**` or any auth response. Its cache name carries the build id, so every deploy replaces it. The CSP (`apps/api/src/app.ts`) gains `worker-src 'self'` and `manifest-src 'self'`.
- **Social:** a public link carries a random share token (≥ 128 bits), which the owner can revoke and rotate. `GET /api/public/:token` returns a sanitised read-only snapshot (tank state and seed, filtered tank name, no owner identity), and the visitor's client runs the same sim from it. No server-side rendering. Public pages send `X-Robots-Tag: noindex` on every host, prod included. Gifts and trades find users by a **public handle** (unique, word-filtered, changeable, defined in T30); emails are never exposed. The handle is in the account export and deleted with the account. On account deletion, pending gifts return to their sender and incoming offers are declined. Reactions, votes and gifts are rate-limited, authenticated and audited. The community tank is one shared server-authoritative tank: everyone feeds it, there's a per-user daily food quota, and its state is pushed over SSE.
- **Reminders:** push subscriptions are personal data, so they are in the account export and deleted with the account. Unsubscribe is a POST with a signed token (RFC 8058 `List-Unsubscribe-Post`), so mail scanners following links can't unsubscribe anyone. A global daily cap (env, default 500) protects the shared relay.
- **Replay:** the lifecycle step records an event timeline (`fed`, `born`, `sick`, `died`, `algae`). The "while you were away" screen plays it as a fast-forward: 20× sim speed between events on high and mid, and on low and mobile a crossfade between event snapshots instead of simulating.
- **Economy:** `packages/shared` adds `wallet` (a balance in integer Pearls) and an append-only `ledger` table: id, user, delta, reason (`purchase`, `earn`, `grant`, `pack`, `refund`), item ref, idempotency key and created time. The balance is the sum of the ledger, cached in a separate `wallet` table (not Better Auth's user table) and updated in the same transaction. Every paid shop route (fish, plants, decor, equipment upgrades, premium food, backgrounds, rooms, tank slots and sizes) charges through one `spend()`: a conditional `UPDATE wallet SET balance = balance - n WHERE user_id = u AND balance >= n RETURNING balance`, so two parallel purchases can't both spend the same Pearls. The debit, its ledger row and the item grant commit in one transaction, and each purchase carries a client idempotency key (unique per user in the ledger), so a retried request can't buy twice. An add-fish request carries `stage: juvenile | adult`. Earning is decided on the server: daily care, healthy-tank streaks, achievements (T51), and fry sold back to the shop at 30 % of the juvenile price. Each earn source has a daily cap. New accounts get a starting grant; existing accounts get a one-off migration grant and keep everything they own. The wallet and ledger are in the account export. On account deletion, play rows (earn, spend, grant) are deleted; rows for real-money transactions are pseudonymised (user reference removed) and kept for the 10 years Luxembourg accounting law requires, which GDPR Art. 17(3)(b) allows. The privacy page names Stripe as a processor. The delete-account confirmation and the terms of sale both say that unspent Pearls, bought ones included, are lost when the account is deleted. In the T69 contract the ledger's user reference is `ON DELETE SET NULL` (not cascade) and payment keys are unique on `(source, idempotency_key)`, independent of the user.
- **Payments:** a Stripe Checkout session is created on the server. Credit happens only from the signature-verified webhook (its own raw-body route, since the app replaces the JSON parser), only once the session is actually paid (`checkout.session.completed` with `payment_status = paid`, or `checkout.session.async_payment_succeeded`), and is idempotent on the **Checkout Session id** (unique in the ledger), because one payment produces several events with different ids. Refunds are keyed on the refund id and disputes on the dispute id: a partial refund claws back Pearls in proportion, repeated refunds add up and never exceed the pack, a lost dispute claws back the rest, and a won dispute restores what it took. The Aquarist Club subscription is created through Checkout (`mode: subscription`); each renewal arrives as `invoice.paid` with no new session. The daily 20 Pearls are granted on the server on the player's first visit of each UTC day while the subscription is `active` and the day falls inside the paid period from the latest paid invoice, keyed on subscription id + UTC day, so a day is never granted twice. Grants stop at cancellation (end of the paid period), on `past_due` or `unpaid`, and when the period ends without a new paid invoice. A refunded subscription invoice claws back the Pearls granted for that invoice's period. A clawback may take the balance negative, which blocks paid purchases until it recovers but never basic care. A receipt mail goes through the relay. Prices come from `content/economy.json` and are mirrored as Stripe Prices, and the client never sends an amount. Secrets live in Dokploy env (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; Stripe's `sk_…`/`whsec_…` format contains underscores, an accepted exception to the alphanumeric rule like VAPID). The ledger has a `source` (`stripe`, later `apple`), so StoreKit can be added for the iOS app without a schema change.
- **Rooms:** `packages/shared` adds `roomIdSchema` (12 ids), `tank.roomId` (default `room-living`, nullable for "no room"), and `PATCH /api/tanks/:id` stores it, like `backgroundId`. Two content files, split by owner: `content/rooms.json` (asset-curator) holds each room's name, asset refs (props and furniture as instanced glTF, a 1k HDRI for reflections and the PMREM), ambience sound and `hasWindow`; `content/presets/rooms/<roomId>.json` (scene-builder) holds the layout around the tank and the light rig (key colour and intensity, window position). The shell (walls, floor, window frame) stays procedural, as in T57's `apps/web/src/scene/room/`, so it costs no download. `content/economy.json` gains `rooms` (`0` = free). Owned rooms are a per-user set on the server, bought through the same `spend()` with an idempotency key. The owned-rooms row is unique on (user, room) and inserted in the same transaction as the debit, so two parallel purchases of one room can't both charge; buying a room the player already owns is refused with 409 `room_already_owned` and charges nothing. A tank can only be set to a room its owner owns (409 `room_not_owned`). Owned rooms are in the account export and deleted with the account. Public tank links and the tank of the week (T61, T62) show the owner's room read-only, without granting it. **Budgets:** the living room is the default, so it counts toward the §2.7 first-load and first-interactive budgets. Each room adds at most 1.8 MB to the repo, ambience audio included, and all 12 rooms together at most 22 MB, both enforced by `assets:check` (assets use about 119 MB of the 150 MB budget in `tools/asset-pipeline/src/check.ts`, so rooms leave about 9 MB of headroom). Raising the 150 MB budget needs Alex. On the GPU: room geometry and textures ≤ 8 MB, ≤ 15 k triangles and ≤ 10 draw calls on mobile; ≤ 24 MB, ≤ 60 k triangles and ≤ 30 draw calls on high (instanced or merged props); on low the room is the HDRI and the procedural shell only. The renderer loads only the active room and disposes the previous one. The tank's stand or cabinet and the floor contact shadow are part of every room.

### 9.3 Tasks

Same rules as §4: one issue, one branch and one PR each, contract first for shared files. Waves
follow the dependencies: a task's wave is one more than its latest dependency's.

| ID | Task | Agent | Depends on | Wave |
|---|---|---|---|---|
| T25 | Contract + API: `tank.backgroundId`, `content/backgrounds` schema, persistence route, migration | backend-engineer | — | 9 |
| T26 | Source 5 background pictures per biome (freshwater, reef) + manifest + credits + `content/backgrounds/*.json` (ids and schema from T25) | asset-curator | T25 | 10 |
| T27 | Background pipeline: crop/resize per tier, KTX2, budget check | asset-pipeline-engineer | T25, T26 | 11 |
| T28 | Render the background plane behind the back glass (all tiers) | render-engineer | T27 | 12 |
| T29 | Background chooser in decorate mode + save through the T25 route + e2e | gameplay-engineer | T25, T28 | 13 |
| T30 | Contract: chemistry v2 (incl. salinity), breeding, personality, disease, equipment, fish stage, tank size, biome enum (+cichlid, blackwater, mangrove), fish cap, public handle, share token | backend-engineer | — | 9 |
| T31 | Lifecycle chemistry v2 + nitrogen cycle + offline catch-up + migrations (existing tanks migrate as cycled) | backend-engineer | T30 | 10 |
| T32 | Water test kit mini-game (strips read by colour) + chemistry HUD | gameplay-engineer | T31 | 11 |
| T33 | Breeding in lifecycle: conditions, births, fry growth, tank fish cap | backend-engineer | T30 | 10 |
| T34 | Spawning/brood behaviours (clownfish egg tending, livebearer drop, fry hiding) | fish-behavior-engineer | T30 | 10 |
| T35 | Fry and juvenile rendering (scale, colour maturity) + birth notifications UI | render-engineer → gameplay-engineer | T33, T34 | 11 |
| T36 | Personality traits: server storage + sim weights + fish card UI + "come to the glass" | backend-engineer → fish-behavior-engineer → gameplay-engineer | T30 | 10 |
| T37 | Disease model in lifecycle + treatments | backend-engineer | T31 | 11 |
| T38 | Disease visuals (ich spots, fin rot, velvet) in the fish material | render-engineer | T30 | 10 |
| T39 | Medicine, quarantine tank and treatment UI | gameplay-engineer | T37, T38 | 12 |
| T40 | Clean-up crew: nerite snail, hermit crab, cleaner wrasse (sourcing + models) | asset-curator → asset-pipeline-engineer | — | 9 |
| T41 | Clean-up crew behaviour: algae grazing, scavenging leftover food, wired to lifecycle | backend-engineer → fish-behavior-engineer | T31, T40 | 11 |
| T42 | Growing plants: growth state, spread, nutrient uptake vs algae, trimming tool | backend-engineer → scene-builder → gameplay-engineer | T31 | 11 |
| T43 | Corals: growth, fragging, bleaching on bad water | backend-engineer → scene-builder → gameplay-engineer | T31 | 11 |
| T44 | Cleaner wrasse (Labroides dimidiatus) cleaning-station behaviour and material (model comes from T40) | fish-behavior-engineer → render-engineer | T40 | 10 |
| T45 | Equipment: lifecycle effects + shop tiers. Warm-water species need a heater (§9.1): migration installs a basic heater in existing tanks and new tanks come with one (the shop warning is T71) | backend-engineer → gameplay-engineer | T31 | 11 |
| T46 | Wave maker current field in sim + coral/plant sway + light schedule ramp | fish-behavior-engineer → scene-builder → render-engineer | T45 | 12 |
| T47 | Tank sizes: nano 30 L, 200 L, long 300 L (capacity, sim bounds, layout, glass and water volume, size picker) | backend-engineer → fish-behavior-engineer → scene-builder → render-engineer → gameplay-engineer | T30 | 10 |
| T48 | New biome: African cichlid lake (preset, 5 backgrounds, 4+ species) | curator → pipeline → backend → scene → behaviour → render → gameplay | T29, T31, T47 | 14 |
| T49 | New biome: Amazon blackwater (tannin water tint, leaf litter, 4+ species) | same chain as T48 | T29, T31, T47 | 14 |
| T50 | New biome: brackish mangrove (roots, 4+ species, salinity) | same chain as T48 | T29, T31, T47 | 14 |
| T51 | Collection book + achievements (server-tracked, UI) | backend-engineer → gameplay-engineer | T33 | 11 |
| T52 | Care reminders: opt-in mail + web push, one-click unsubscribe, per-user and global daily caps | backend-engineer → gameplay-engineer | T53 | 10 |
| T53 | PWA: manifest, icons, service worker shell, install prompt, offline "tank asleep" page | backend-engineer (CSP) → gameplay-engineer → devops-engineer | — | 9 |
| T54 | Photo mode: free camera, DOF, filters, hide UI, save/share PNG | render-engineer → gameplay-engineer | — | 9 |
| T55 | Toys: mirror (betta flares), ping-pong ball; feeding-target mini-game | fish-behavior-engineer → gameplay-engineer | — | 9 |
| T56 | Away replay: lifecycle event timeline + fast-forward playback | backend-engineer → gameplay-engineer | T31 | 11 |
| T57 | Room: living-room/office backdrops, simulated window weather and time-of-day light, idle camera | scene-builder → render-engineer → gameplay-engineer | T28 | 13 |
| T58 | Night: nocturnal species active at night, coral polyps out, lights on/off ramp startles fish | fish-behavior-engineer → scene-builder → render-engineer | T46 | 13 |
| T59 | Sound: CC0 sourcing, audio encoding + size check, audio engine, filter hum, bubbles, dive muffle, glass tap | asset-curator → asset-pipeline-engineer → gameplay-engineer | — | 9 |
| T60 | Haptics (Android) on tap, feed and catch | gameplay-engineer | — | 9 |
| T61 | Public tank links (read-only, share token) + reactions | backend-engineer → gameplay-engineer | T25, T30 | 10 |
| T62 | Tank of the week gallery + votes | backend-engineer → gameplay-engineer | T61 | 11 |
| T63 | Gift/trade fish between users by public handle (escrow, both accept, acclimation bag) | backend-engineer → gameplay-engineer | T61 | 11 |
| T64 | Community tank: shared server tank, food quota, SSE state | backend-engineer → gameplay-engineer | T61, T31 | 11 |
| T65 | Security review of social, push, mail, wallet and payment features (incl. the EU virtual-currency consumer rules) | code-reviewer | T52, T61, T62, T63, T64, T70, T72 | 13 |
| T66 | Audit pass 2: realism, perf budgets on all biomes and sizes, iPhone 15 Pro Max numbers | visual-perf-auditor | T47, T48, T49, T50, T57, T58, T77 | 16 |
| T67 | E2E for every expansion feature | gameplay-engineer | T29–T64, T69–T78 | 17 |
| T68 | Fix wave from T65/T66, then RC2 on devfish → **stop and ask Alex** for `dev → main` | owners of each finding → devops-engineer | T65, T66, T67 | 18 |
| T69 | Contract: wallet, ledger, `content/economy.json` (a price for every shop item, juvenile and adult prices per species, earn rules and caps, Pearl packs, subscription), add-fish `stage` | backend-engineer | T30 | 10 |
| T70 | Server economy: wallet and ledger with migration, atomic `spend()` with idempotency keys on every paid shop route, basic care never charged, juvenile or adult purchase, earn rules with daily caps, starting and migration grants, export and deletion with retention | backend-engineer | T69, T33 | 11 |
| T71 | Shop UI: categories, a price on every item, juvenile/adult toggle (price and size), Pearl balance in the HUD, not-enough-Pearls flow, heater warning, purchase confirmation, earn feedback, euro value per item, no pressure design (the adult purchase confirmation belongs to T72) | gameplay-engineer | T70, T45, T35 | 12 |
| T72 | Pearl packs and subscription on the web: Stripe Checkout, verified raw-body webhook, credit once per paid Checkout Session, refund and dispute handling, receipt mail, real price shown, withdrawal-waiver consent and acknowledgement, subscription grants (daily, keyed on subscription id + UTC day, stop on cancel/past_due/unpaid/period end, clawback on refunded invoice), one-step subscription cancel, adult confirmation (owner of the rule and its UI: T72), lost-Pearls warning on account deletion, terms of sale; test mode on devfish, live only once Alex sets it up | backend-engineer → gameplay-engineer | T70 | 12 |
| T73 | Contract: `roomIdSchema`, nullable `tank.roomId`, `content/rooms.json` and `content/presets/rooms/*.json` schemas, room prices in `content/economy.json`, owned-rooms set, `tank.roomSetAt` (null until the player saves a room), 409 `room_not_owned` and `room_already_owned` | backend-engineer | T69 | 11 |
| T74 | Room sourcing: CC0/CC-BY props, furniture, HDRIs and ambience audio (`.m4a`) for all 12 rooms, the manifest, `content/rooms.json` asset refs, KTX2 and LOD through the pipeline, per-room (1.8 MB) and all-rooms (22 MB) size budgets in `assets:check` | asset-curator → asset-pipeline-engineer | T73 | 12 |
| T75 | Server rooms: buy a room through `spend()` (refuse one already owned), set a tank's room (owned only), the living-room migration, the home-office grant for existing accounts, export and deletion, read-only in public links | backend-engineer | T73, T70 | 12 |
| T76 | Room scenes: the 12 layouts around the tank (stand, walls, furniture, window or view) in `content/presets/rooms/`, per-room light rig, T57 window weather and time of day where there is a window, community tank in the public aquarium hall | scene-builder | T74, T57 | 14 |
| T77 | Room rendering: load and dispose per room, room PMREM and reflections in the glass, per-tier GPU, triangle and draw-call budgets with a test, HDRI-only room on low | render-engineer | T76 | 15 |
| T78 | Room picker in decorate mode: previews, "no room", free or price with euro value, buy through the T71 shop flow, ambience through the T59 audio engine and settings, one-time migration of the `aquarium.room` device setting | gameplay-engineer | T75, T77, T71, T59 | 16 |

Multi-owner tasks are split into one PR per owner when dispatched, chained in the order shown by
the arrows: the data owner first, the visuals and UI after it.

**Ownership added for §9:** `content/backgrounds/*.json` → asset-curator. `content/chemistry.json`
→ backend-engineer. `content/economy.json` → backend-engineer. `content/rooms.json` → asset-curator and `content/presets/rooms/*.json` → scene-builder (schemas: backend-engineer in T73). `apps/web/index.html`, `apps/web/public/` outside `assets/`,
`apps/web/vite.config.ts` and `apps/web/src/pwa/**` → gameplay-engineer.
