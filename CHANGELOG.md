# Changelog

## 0.2.0: second release candidate

The expansion (PLAN §9) plus its fix wave. Verified on devfish at `91fff38d`; the on-demand e2e run passed 29/29 shards.

### New tanks and rooms

- Three more tank types: Amazon blackwater, Rift Lake cichlid and brackish mangrove, each with its own water look, backgrounds, fish, wood, roots and mud. Salt, buffer and botanicals care actions, and CO2 control with a tier picker.
- Mudskippers haul out onto an emergent bank in the mangrove tank; the figure-8 puffer joins freshwater.
- Ten tank background photos, a background chooser in decorate mode, and nano, 200 L and long 300 L tank sizes with per-size stocking limits.
- Twelve rooms behind the tank with their own lighting, window weather, props and ambience; buy and pick them from the room picker.
- Cherry and cleaner shrimp, nerite snails and hermit crabs, a cleaner wrasse with a cleaning station, and a clean-up crew that grazes and scavenges, also while you are away.

### Living tank

- Chemistry with a nitrogen cycle and seeded filters; a water test kit with strips and a persistent chemistry chip.
- Breeding with fry that grow, egg tending and hiding; fish personalities that come to the glass when you visit.
- Diseases (ich, fin rot, velvet) with medicine, treatment and a quarantine tank; move fish between tanks.
- Growing plants that take up nitrate, spread and can be trimmed; corals that grow, bleach in bad water and can be fragged.
- A wave maker current, equipment tiers, a lamp schedule, and a heater you can remove and reinstall from Care.
- Fish rest at night, polyps extend, and lights on and off startle the school.
- Play: mirror, ping-pong ball and shy-fish feeding game.

### Social and shop

- Pearls wallet, a shop with equipment tiers, Pearl packs and the Aquarist Club through Stripe (off unless configured).
- Public tank links with reactions, a read-only viewer, a tank of the week gallery with weekly votes, a shared community tank, player handles, and gifting or trading fish.
- A collection book and achievements; an away replay timeline with fast-forward.

### Device and polish

- Installable PWA with an offline page and install prompt, care reminders by mail and web push, haptics, and a Web Audio engine with ambience and glass tap.
- Photo mode with capture, save and share, and a loading screen with real progress.
- Distant fish use octahedral impostors at low and medium tiers; settings for refresh rate and full resolution.

### Fix wave

- Tank algae show on the glass; the photo camera pad stays in view above the sliders and its release step honours opposite and fast keys.
- Faster scene start: pipelines link in parallel, one PMREM generator is kept, reef builds yield between steps; lighter glass, plants and substrate at the low tier.
- Fish draw their coast from the sim's glide weight; a VAPID key with a stripped leading zero is accepted; the device-room migration runs once per device; the community handle refreshes after a save.
- End-to-end shards rebalanced and the pre-release e2e failures fixed.

## 0.1.0: first release candidate

First release of the aquarium. `main` held only the bootstrap skeleton before this.

### Tanks and scenery

- A planted freshwater tank with swaying plants and hardscape.
- A tropical reef tank with an arch, branching and table corals, a host anemone and pale sand. Corals fluoresce under the actinic light and moonlight.
- Switch between freshwater and reef from the tank menu; one account can keep one of each.
- Photorealistic water: caustics, a day and night cycle, and a soft daytime fill light.
- WebGPU where available, with an automatic WebGL 2 fallback.

### Fish

- Ten species (neon tetra, guppy, betta, angelfish, bronze corydoras, ocellaris clownfish, royal gramma, Banggai cardinalfish, blue tang, yellow tang), each with its own swimming style, schooling and shyness.
- Fish swim with real body motion, school with their neighbours, steer around plants, hardscape and decor, and startle together.
- Clownfish host in the anemone; grazers pick at the substrate.
- Add and remove fish in a running tank.

### Play and care

- Feed with food that sinks and floats and is eaten by hungry fish.
- Tap the glass, chase a laser, hand-feed, and blow bubbles with the wand.
- Fish get hungry and grow; water quality drifts with overfeeding and neglect, and fish can die. Deaths are reported and the fish is netted and remembered in a memorial.
- A shop, an acclimation bag and the routine chores (vacuum the gravel, change half the water, scrape the glass).
- Decorate mode: place, move, swap and remove decor, with live colliders for the fish. Layouts are saved.

### Accounts and data

- Sign up with an email and password, then add a passkey from account settings and sign in with it; verification and password-reset mail comes from `fish@bas.lu`.
- Tanks, fish and decor are saved to your account and look the same on every device. The server is authoritative for lifecycle and care.
- Privacy policy, credits, data export, and account deletion.
- Rate limits on sign-up, sign-in and mail.

### Phones and performance

- Quality tiers chosen by measuring the device's GPU; an on-device stats readout behind `?stats=1`.
- Faster tank switches and startup: shaders are smaller and compile faster.
- Minimum Safari 16.
- The first download is small: three.js loads after the interface shell, and textures are KTX2 with a content-hashed transcoder worker.

### Hosting

- Docker image on `node:24-slim`, running as a non-root user with a health check on `/api/health`; database migrations run at start.
- `devfish.bas.lu` is noindex. `fish.bas.lu` is indexable, and serves only once `main` is deployed.
- CI runs typecheck, lint, tests with Postgres, build, the asset licence and size check, a bundle-size gate, a container smoke test, and sharded end-to-end tests.
