# Changelog

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
- Minimum Safari 16.
- The first download is small: three.js loads after the interface shell, and textures are KTX2 with a content-hashed transcoder worker.

### Hosting

- Docker image on `node:24-slim`, running as a non-root user with a health check on `/api/health`; database migrations run at start.
- `devfish.bas.lu` is noindex. `fish.bas.lu` is indexable, and serves only once `main` is deployed.
- CI runs typecheck, lint, tests with Postgres, build, the asset licence and size check, a bundle-size gate, a container smoke test, and sharded end-to-end tests.
