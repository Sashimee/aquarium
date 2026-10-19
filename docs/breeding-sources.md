# Breeding data sources

The `breeding` block in `content/species/*.json` is strict JSON with no source field, so the
citations live here. Species not listed have `mode: "none"`: neon tetra, harlequin rasbora,
firefish and the reef fish and shrimp that are not bred in home tanks.

Two rules turn the real biology into game values:

- **Time is real time.** `minAgeDays`, `intervalDays` and `fryGrowth` are days on the server clock,
  matching how long the real animal takes, rounded to hobby-typical figures.
- **Broods are scaled down.** Real broods run to hundreds of eggs. `broodSize` is a small number of
  surviving fry, so the animal cap (PLAN 9.1) and the bioload limit stay meaningful. The real range
  is quoted below for reference.

Sources are the FishBase species page (reproduction and biology tabs, Froese and Pauly, eds.,
fishbase.org) and the standard hobby husbandry references named per row. The figures are
approximate husbandry ranges, not measurements. A PR reviewer should check any value they doubt
against the page named here; the values were not re-fetched when this file was written.

| Species | Mode | Real behaviour used | Game values | Source |
|---|---|---|---|---|
| Guppy, *Poecilia reticulata* | livebearer | Gestation about 4 weeks at 25 C, broods of 2 to 200 (typically 20 to 40), mature at 2 to 3 months | min age 90 d, interval 28 d, brood 3 to 8, 22 to 28 C | FishBase `Poecilia-reticulata` |
| Betta, *Betta splendens* | substrate-spawner | Male builds a bubble nest, 100 to 500 eggs, mature at 4 to 6 months | min age 150 d, interval 21 d, brood 4 to 10, 26 to 30 C | FishBase `Betta-splendens` |
| Angelfish, *Pterophyllum scalare* | substrate-spawner | Pair cleans a leaf, 100 to 1200 eggs, hatch in 2 to 3 days, mature at 6 to 12 months | min age 270 d, interval 14 d, brood 4 to 10, 26 to 30 C | FishBase `Pterophyllum-scalare` |
| Discus, *Symphysodon aequifasciatus* | substrate-spawner | Pair guards 100 to 200 eggs, fry feed on parental mucus, mature at 12 to 18 months | min age 450 d, interval 21 d, brood 3 to 8, 28 to 31 C | FishBase `Symphysodon-aequifasciatus` |
| Bronze corydoras, *Corydoras aeneus* | egg-scatterer | Eggs placed on glass and plants after a "T-position" chase, 20 to 100 eggs, mature at 8 to 12 months | min age 240 d, interval 14 d, brood 3 to 8, 22 to 26 C | FishBase `Corydoras-aeneus` |
| Bristlenose pleco, *Ancistrus* sp. | substrate-spawner, needs a cave | Male guards eggs in a cave, 20 to 200 eggs, mature at 12 to 18 months | min age 365 d, interval 45 d, brood 3 to 8, 24 to 28 C, shelter in tank | FishBase `Ancistrus-cirrhosus` |
| Ocellaris clownfish, *Amphiprion ocellaris* | substrate-spawner | Pair lays 100 to 1000 eggs on rock near the host, repeats every 10 to 14 days, mature at about 12 months | min age 365 d, interval 14 d, brood 3 to 8, 25 to 28 C | FishBase `Amphiprion-ocellaris` |
| Banggai cardinalfish, *Pterapogon kauderni* | mouthbrooder | Male incubates 9 to 30 eggs for about 4 weeks and releases fully formed juveniles, mature at about 9 months | min age 270 d, interval 30 d, brood 3 to 8, 24 to 27 C; the male is the brooder | FishBase `Pterapogon-kauderni` |
| Cherry shrimp, *Neocaridina davidi* | livebearer (stand-in) | Female carries 20 to 30 eggs for 3 to 4 weeks and hatches miniature shrimp, mature at about 3 months | min age 90 d, interval 30 d, brood 3 to 8, 22 to 28 C | hobby husbandry consensus; FishBase does not cover invertebrates |

Game rules that are not from the literature: a brood needs a healthy (at least 0.8), fed (hunger at
most 0.5) adult in a clean tank (ammonia within the species tolerance) and a living adult of the
other sex. Birth chance per 10-minute step is 1 in 144, so a ready pair breeds about a day after
it qualifies. Fry and juveniles may fill at most half of a tank's animal cap, and births stop at
the cap and at the tank bioload capacity. The shelter set for cave species is
`BREEDING_SHELTER_ASSET_IDS` in `packages/sim/lifecycle/params.ts`; no dedicated cave asset exists
yet.
