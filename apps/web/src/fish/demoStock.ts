import {
  createTankSpace,
  sampleFloor,
  speciesSchema,
  tankWaterTop,
  type Biome,
  type TankSpace,
} from '@aquarium/shared';
import {
  Rng,
  type Anchor,
  type FishSpawn,
  type SpeciesInput,
  type TankSpaceWorldConfig,
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
import { substrateHeight } from '../engine/tank/substrate';
import type { SceneAnchor } from '../scene/anemone';

// Content files get their render block with the fish models; the demo needs everything else.
const contentSchema = speciesSchema.partial({ render: true });

export interface DemoStock {
  readonly species: readonly SpeciesInput[];
  readonly counts: Readonly<Record<string, number>>;
  /** Adult size cap from content, so the length spread never grows a fish past its species. */
  readonly maxLengthM: Readonly<Record<string, number>>;
}

/**
 * `wanted` is the count the demo asks for. A schooling species is raised to its content
 * `minGroup`, so the demo never shows a shoal the care rules would call stressed.
 */
function stock(raw: readonly unknown[], wanted: Readonly<Record<string, number>>): DemoStock {
  const content = raw.map((r) => contentSchema.parse(r));
  for (const id of Object.keys(wanted)) {
    if (!content.some((s) => s.id === id)) throw new Error(`demo stock: ${id} has no content`);
  }
  const counts = Object.fromEntries(
    content.map(({ id, behaviour }) => [
      id,
      Math.max(wanted[id] ?? 0, behaviour.schooling?.minGroup ?? 0),
    ]),
  );
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
 * (a blue tang outgrows a 120 cm tank), and as many banggai as content's smallest group.
 */
export const DEMO_STOCKS: Readonly<Record<Biome, DemoStock>> = {
  freshwater: stock(
    [neonTetraContent, angelfishContent, bronzeCorydorasContent, bettaContent, guppyContent],
    { 'neon-tetra': 14, angelfish: 2, 'bronze-corydoras': 5, betta: 1, guppy: 4 },
  ),
  reef: stock(
    [ocellarisClownfishContent, yellowTangContent, royalGrammaContent, banggaiCardinalfishContent],
    { 'ocellaris-clownfish': 2, 'yellow-tang': 1, 'royal-gramma': 1, 'banggai-cardinalfish': 1 },
  ),
};

const LENGTH_SPREAD = 0.08;

export interface DemoTank {
  /** In tank space, the scene's own frame: positions cross to and from the sim unchanged. */
  readonly config: TankSpaceWorldConfig;
}

/** The scene's tank as the shared tank space, its floor sampled from the sand the scene draws. */
export function tankSpaceOf(tank: TankDimensions): TankSpace {
  return createTankSpace(
    {
      width: tank.length,
      depth: tank.depth,
      height: tank.height,
      glass: tank.glass,
      freeboard: tank.freeboard,
      inset: WATER_INSET,
    },
    (x, z) => substrateHeight(tank, x, z),
  );
}

export function demoTank(tank: TankDimensions, seed: number, biome: Biome): DemoTank {
  const { species, counts, maxLengthM } = DEMO_STOCKS[biome];
  const rng = new Rng(seed);
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
  return { config: { seed, space: tankSpaceOf(tank), species, fish } };
}

/**
 * Scene anchors are already in the sim's frame. The radius is capped to a quarter of the water
 * column under the anchor, and the centre kept that far off the sand and the surface, because the
 * sim rejects an anchor outside the water.
 */
export function sceneAnchorsToSim(anchors: readonly SceneAnchor[], demo: DemoTank): Anchor[] {
  const { space } = demo.config;
  const top = tankWaterTop(space);
  return anchors.map((a) => {
    const [x, y, z] = a.position;
    const ground = sampleFloor(space, x, z);
    const radius = Math.min(a.radius, (top - ground) / 4);
    return {
      id: a.id,
      kind: a.kind,
      position: [x, Math.min(Math.max(y, ground + radius), top - radius), z],
      radius,
    };
  });
}
