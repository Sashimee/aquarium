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
| Fish assets | **Free only: CC0 or CC-BY (3.0/4.0).** No NC, no ND. CC-BY-SA only after asking. **Approved by Alex 2026-10-12 (#29):** CC-BY-SA reference photos for fallback textures by these authors only: Corydoras aeneus (Gabriel Resende Veiga / GABS), Gramma loreto (H. Zell / Llez), Pterapogon kauderni (David J. Stang); textures derived from them ship as CC-BY-SA with attribution. Every CC-BY and CC-BY-SA asset is credited in-app at `/credits` and in `CREDITS.md`. |
| Biome | **Both, switchable**: planted freshwater and tropical reef. One user can own one of each, and the schema allows more later. |
| Gameplay | **Full sim plus persistence**: feeding, play, decorating, growth, water quality, and **fish can die** from realistic neglect or overfeeding. |
| Accounts | **User accounts**: passkeys first, plus email and password. Verification and reset mails go via `mailrelay` from `fish@bas.lu`. |
| Devices | **Desktop and mobile**: WebGPU with automatic WebGL2 fallback, and quality tiers chosen by measuring the GPU. **Minimum Safari 16**: the CSP uses `wasm-unsafe-eval`, which Safari 15 and older do not know, so meshopt and the basis transcoder would not compile there. The web build targets `es2022` + `safari16`. |
| Dev access | `devfish.bas.lu` is public, `X-Robots-Tag: noindex` plus a `robots.txt` that disallows everything. |
| Dokploy | Both apps inside the existing **Bas.lu** project. |
| Merging | **Repo-local override of the global rule**: the orchestrator squash-merges feature PRs into `dev` once CI is green **and** `code-reviewer` approves. `dev → main` happens **only when Alex asks**. |
| Concurrency | Up to **6** agents at once. |

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
- **New fish:** free "shop" limited by tank capacity (bioload). New fish arrive in a bag that floats for acclimation, then are released.

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
Branch names are `feat/<issue>-<slug>`. Every PR must pass CI and `code-reviewer` before the
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
| T23 | Release candidate on devfish: full checks, prod Postgres backup schedule, prod env, `CHANGELOG`, then **stop and ask Alex** for `dev → main` | devops-engineer | T19, T22 | 7 |
| T24 | Extended roster: discus, rasbora, pleco, shrimp, wrasse, firefish, cleaner shrimp | curator → pipeline → behaviour → render | T22 | 8 |

### Concurrency map (max 6)

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
merged, up to 6 running agents including reviewers. The wave column only shows the earliest a task
can start.

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
`SMTP_PORT=587`, `MAIL_FROM=fish@bas.lu`, `SITE_INDEXABLE`, `NODE_ENV=production`.

Dokploy API: `https://dok.seil.pro/api`, header `x-api-key`, token read from
`~/.config/dokploy/seil.token`. Never print the token or any env value. GitHub provider: *GitHub Alex*.

**Main protection:** this is a private repo on a free GitHub plan, so there is no branch protection.
`.githooks/pre-push` refuses pushes to `main` that aren't fast-forwards from a merged `dev` PR, and
refuses all force-pushes. Set it up with `git config core.hooksPath .githooks`.

## 6. Quality gates (every PR)

`pnpm typecheck` · `pnpm lint` · `pnpm test` (vitest: sim and lifecycle deterministic tests, API
tests against real Postgres in CI) · `pnpm build` · `pnpm assets:check` (licences and manifest) ·
Docker image builds · from T19 on: `pnpm e2e` (Playwright, WebGL2 path; WebGPU path run locally
where a GPU exists).

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
| Merge conflicts at 6-way concurrency | Directory ownership, contract-first PRs, fast review and merge of shared-file PRs |
| Repo bloat from assets | Only processed assets committed, budget < 150 MB enforced by `assets:check` |

## 8. Open items for later (not blocking)

- Prod DB backup destination (Dokploy S3 target?). Ask at T23.
- Whether to send "your fish are hungry" reminder emails (needs opt-in). Not in scope unless asked.
