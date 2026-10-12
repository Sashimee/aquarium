import { Rng, type FishSpawn, type SpeciesInput, type WorldConfig } from '@aquarium/sim';
import angelfishContent from '../../../../content/species/angelfish.json';
import bettaContent from '../../../../content/species/betta.json';
import bronzeCorydorasContent from '../../../../content/species/bronze-corydoras.json';
import guppyContent from '../../../../content/species/guppy.json';
import neonTetraContent from '../../../../content/species/neon-tetra.json';
import type { TankDimensions } from '../engine/tank/dimensions';
import { WATER_INSET } from '../engine/tank/dimensions';

/**
 * Behaviour and locomotion for the anonymous demo tank, matching the sim's test archetypes.
 * TODO(render-engineer): read these from content/species once T10 adds locomotion there.
 */
const neonTetra: SpeciesInput = {
  id: 'neon-tetra',
  behaviour: {
    schooling: { minGroup: 6, topologicalNeighbours: 7, tightenWhenStartled: true },
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.3, 0.7],
    perceptionRangeM: 0.3,
    perceptionFovDeg: 300,
    curiosity: 0.4,
    boldness: 0.3,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'carangiform',
    gait: 'burst-and-coast',
    maxSpeedMps: 0.5,
    cruiseSpeedMps: 0.12,
    massKg: 0.0005,
    maxTurnRateDegPerS: 540,
    maxPitchDeg: 30,
    strouhal: 0.3,
    bodyLengthM: 0.032,
  },
};

const angelfish: SpeciesInput = {
  id: 'angelfish',
  behaviour: {
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.35, 0.8],
    perceptionRangeM: 0.5,
    perceptionFovDeg: 300,
    curiosity: 0.6,
    boldness: 0.5,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'labriform',
    gait: 'hover',
    maxSpeedMps: 0.6,
    cruiseSpeedMps: 0.06,
    massKg: 0.03,
    maxTurnRateDegPerS: 180,
    maxPitchDeg: 25,
    strouhal: 0.3,
    bodyLengthM: 0.12,
  },
};

const bronzeCorydoras: SpeciesInput = {
  id: 'bronze-corydoras',
  behaviour: {
    schooling: { minGroup: 4, topologicalNeighbours: 5, tightenWhenStartled: false },
    territorial: false,
    preferredZone: 'bottom',
    depthBand: [0, 0.25],
    perceptionRangeM: 0.25,
    perceptionFovDeg: 300,
    curiosity: 0.3,
    boldness: 0.4,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'subcarangiform',
    gait: 'forage',
    maxSpeedMps: 0.5,
    cruiseSpeedMps: 0.05,
    massKg: 0.005,
    maxTurnRateDegPerS: 360,
    maxPitchDeg: 60,
    strouhal: 0.3,
    bodyLengthM: 0.065,
  },
};

const betta: SpeciesInput = {
  id: 'betta',
  behaviour: {
    territorial: true,
    preferredZone: 'surface',
    depthBand: [0.6, 1],
    perceptionRangeM: 0.4,
    perceptionFovDeg: 300,
    curiosity: 0.7,
    boldness: 0.8,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'subcarangiform',
    gait: 'hover',
    maxSpeedMps: 0.4,
    cruiseSpeedMps: 0.04,
    massKg: 0.004,
    maxTurnRateDegPerS: 300,
    maxPitchDeg: 35,
    strouhal: 0.3,
    bodyLengthM: 0.055,
  },
};

const guppy: SpeciesInput = {
  id: 'guppy',
  behaviour: {
    schooling: { minGroup: 3, topologicalNeighbours: 4, tightenWhenStartled: true },
    territorial: false,
    preferredZone: 'surface',
    depthBand: [0.5, 0.95],
    perceptionRangeM: 0.3,
    perceptionFovDeg: 300,
    curiosity: 0.6,
    boldness: 0.5,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'subcarangiform',
    gait: 'cruise',
    maxSpeedMps: 0.4,
    cruiseSpeedMps: 0.08,
    massKg: 0.0006,
    maxTurnRateDegPerS: 450,
    maxPitchDeg: 30,
    strouhal: 0.3,
    bodyLengthM: 0.04,
  },
};

export const DEMO_SPECIES: readonly SpeciesInput[] = [
  neonTetra,
  angelfish,
  bronzeCorydoras,
  betta,
  guppy,
];

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
  [neonTetraContent, angelfishContent, bronzeCorydorasContent, bettaContent, guppyContent].map(
    (s) => [s.id, s.lifecycle.maxSizeM],
  ),
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
