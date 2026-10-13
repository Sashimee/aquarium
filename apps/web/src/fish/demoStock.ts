import { speciesSchema, type Biome } from '@aquarium/shared';
import {
  Rng,
  type Anchor,
  type FishSpawn,
  type SpeciesInput,
  type WorldConfig,
} from '@aquarium/sim';
import angelfishContent from '../../../../content/species/angelfish.json';
import banggaiCardinalfishContent from '../../../../content/species/banggai-cardinalfish.json';
import bettaContent from '../../../../content/species/betta.json';
import bronzeCorydorasContent from '../../../../content/species/bronze-corydoras.json';
import guppyContent from '../../../../content/species/guppy.json';
import neonTetraContent from '../../../../content/species/neon-tetra.json';
import ocellarisClownfishContent from '../../../../content/species/ocellaris-clownfish.json';
import royalGrammaContent from '../../../../content/species/royal-gramma.json';
import yellowTangContent from '../../../../content/species/yellow-tang.json';
import type { TankDimensions } from '../engine/tank/dimensions';
import { WATER_INSET } from '../engine/tank/dimensions';
import type { SceneAnchor } from '../scene/anemone';

// Content files get their render block with the fish models; the demo needs everything else.
const contentSchema = speciesSchema.partial({ render: true });

export interface DemoStock {
  readonly species: readonly SpeciesInput[];
  readonly counts: Readonly<Record<string, number>>;
  /** Adult size cap from content, so the length spread never grows a fish past its species. */
  readonly maxLengthM: Readonly<Record<string, number>>;
}

function stock(raw: readonly unknown[], counts: Readonly<Record<string, number>>): DemoStock {
  const content = raw.map((r) => contentSchema.parse(r));
  return {
    species: content.map(({ id, behaviour, locomotion, lifecycle }) => ({
      id,
      behaviour,
      locomotion,
      lifecycle: { diet: lifecycle.diet },
    })),
    counts,
    maxLengthM: Object.fromEntries(content.map((s) => [s.id, s.lifecycle.maxSizeM])),
  };
}

/**
 * Guppies are all female: a male needs its own asset batch, and batches are keyed by species.
 * The reef has one clownfish pair for its one host anemone, a yellow rather than a blue tang
 * (a blue tang outgrows a 120 cm tank), and three banggai because content asks for a group of three.
 */
export const DEMO_STOCKS: Readonly<Record<Biome, DemoStock>> = {
  freshwater: stock(
    [neonTetraContent, angelfishContent, bronzeCorydorasContent, bettaContent, guppyContent],
    { 'neon-tetra': 14, angelfish: 2, 'bronze-corydoras': 5, betta: 1, guppy: 4 },
  ),
  reef: stock(
    [ocellarisClownfishContent, yellowTangContent, royalGrammaContent, banggaiCardinalfishContent],
    { 'ocellaris-clownfish': 2, 'yellow-tang': 1, 'royal-gramma': 1, 'banggai-cardinalfish': 3 },
  ),
};

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
export function demoTank(tank: TankDimensions, seed: number, biome: Biome): DemoTank {
  const { species, counts, maxLengthM } = DEMO_STOCKS[biome];
  const rng = new Rng(seed);
  const floorY = tank.glass + Math.max(tank.substrateFront, tank.substrateBack) + 0.01;
  const waterTop = tank.height - tank.freeboard;
  const fish: FishSpawn[] = [];
  for (const s of species) {
    const count = counts[s.id] ?? 0;
    const maxLength = maxLengthM[s.id];
    if (maxLength === undefined) throw new Error(`demo stock: no content size for ${s.id}`);
    for (let i = 0; i < count; i++) {
      const variation = 1 + LENGTH_SPREAD * rng.signed();
      fish.push({
        id: `${s.id}-${i}`,
        species: s.id,
        bodyLengthM: Math.min(s.locomotion.bodyLengthM * variation, maxLength),
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
      species,
      fish,
    },
    offset: [0, floorY, 0],
  };
}

/**
 * Scene anchors measure y from the bottom glass. They go into the demo sim's frame, whose flat
 * floor is at `offset`, rather than through the per-point substrate height the food uses: that
 * is the frame the fish are drawn from, so the pair holds station where the anemone is seen. An
 * anemone on low sand can sit below that floor, so its anchor is lifted until the anchor sphere
 * clears it, which keeps the pair just over the tentacles.
 */
export function sceneAnchorsToSim(anchors: readonly SceneAnchor[], demo: DemoTank): Anchor[] {
  const [ox, oy, oz] = demo.offset;
  const { height } = demo.config.tank;
  return anchors.map((a) => {
    const [x, y, z] = a.position;
    const radius = Math.min(a.radius, height / 4);
    return {
      id: a.id,
      kind: a.kind,
      position: [x - ox, Math.min(Math.max(y - oy, radius), height - radius), z - oz],
      radius,
    };
  });
}
