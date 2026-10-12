import { speciesSchema } from '@aquarium/shared';
import { Rng, type FishSpawn, type SpeciesInput, type WorldConfig } from '@aquarium/sim';
import angelfishContent from '../../../../content/species/angelfish.json';
import bettaContent from '../../../../content/species/betta.json';
import bronzeCorydorasContent from '../../../../content/species/bronze-corydoras.json';
import guppyContent from '../../../../content/species/guppy.json';
import neonTetraContent from '../../../../content/species/neon-tetra.json';
import type { TankDimensions } from '../engine/tank/dimensions';
import { WATER_INSET } from '../engine/tank/dimensions';

// Content files get their render block with the fish models; the demo needs everything else.
const contentSchema = speciesSchema.partial({ render: true });

const DEMO_CONTENT = [
  neonTetraContent,
  angelfishContent,
  bronzeCorydorasContent,
  bettaContent,
  guppyContent,
].map((raw) => contentSchema.parse(raw));

export const DEMO_SPECIES: readonly SpeciesInput[] = DEMO_CONTENT.map(
  ({ id, behaviour, locomotion }) => ({ id, behaviour, locomotion }),
);

/** Guppies are all female: a male needs its own asset batch, and batches are keyed by species. */
export const DEMO_COUNTS: Readonly<Record<string, number>> = {
  'neon-tetra': 14,
  angelfish: 2,
  'bronze-corydoras': 5,
  betta: 1,
  guppy: 4,
};

/** Adult size cap from content, so the length spread never grows a fish past its species. */
export const DEMO_MAX_LENGTH_M: Readonly<Record<string, number>> = Object.fromEntries(
  DEMO_CONTENT.map((s) => [s.id, s.lifecycle.maxSizeM]),
);

const LENGTH_SPREAD = 0.08;

export interface DemoTank {
  readonly config: WorldConfig;
  /** Engine-space position of the sim's origin (the centre of its flat floor). */
  readonly offset: readonly [number, number, number];
}

/**
 * The sim has a flat floor, so it sits on the highest point of the sloped substrate: fish at the
 * front then hover a few centimetres above the gravel instead of sinking into it at the back.
 */
export function demoTank(tank: TankDimensions, seed: number): DemoTank {
  const rng = new Rng(seed);
  const floorY = tank.glass + Math.max(tank.substrateFront, tank.substrateBack) + 0.01;
  const waterTop = tank.height - tank.freeboard;
  const fish: FishSpawn[] = [];
  for (const species of DEMO_SPECIES) {
    const count = DEMO_COUNTS[species.id] ?? 0;
    const maxLength = DEMO_MAX_LENGTH_M[species.id];
    if (maxLength === undefined) throw new Error(`demo stock: no content size for ${species.id}`);
    for (let i = 0; i < count; i++) {
      const variation = 1 + LENGTH_SPREAD * rng.signed();
      fish.push({
        id: `${species.id}-${i}`,
        species: species.id,
        bodyLengthM: Math.min(species.locomotion.bodyLengthM * variation, maxLength),
      });
    }
  }
  return {
    config: {
      seed,
      tank: {
        width: tank.length - 2 * (tank.glass + WATER_INSET),
        depth: tank.depth - 2 * (tank.glass + WATER_INSET),
        height: waterTop - floorY,
      },
      species: DEMO_SPECIES,
      fish,
    },
    offset: [0, floorY, 0],
  };
}
