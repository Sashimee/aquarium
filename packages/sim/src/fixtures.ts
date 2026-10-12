import type { SpeciesInput } from './species.ts';
import type { FishSpawn, WorldConfig } from './world.ts';

/**
 * Archetypes spanning the roster's size, speed and depth range, for tests and the benchmark.
 * The shipped values live in content/species/*.json.
 */
export const neonTetra: SpeciesInput = {
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
    bodyLengthM: 0.035,
  },
};

export const angelfish: SpeciesInput = {
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

export const blueTang: SpeciesInput = {
  id: 'blue-tang',
  behaviour: {
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.2, 0.9],
    perceptionRangeM: 0.8,
    perceptionFovDeg: 300,
    curiosity: 0.5,
    boldness: 0.6,
    traits: [],
  },
  locomotion: {
    swimmingMode: 'labriform',
    gait: 'cruise',
    maxSpeedMps: 1.2,
    cruiseSpeedMps: 0.25,
    massKg: 0.25,
    maxTurnRateDegPerS: 240,
    maxPitchDeg: 30,
    strouhal: 0.3,
    bodyLengthM: 0.2,
  },
};

export const bronzeCorydoras: SpeciesInput = {
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
    bodyLengthM: 0.06,
  },
};

export const betta: SpeciesInput = {
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
    bodyLengthM: 0.06,
  },
};

export const ARCHETYPES: readonly SpeciesInput[] = [
  neonTetra,
  angelfish,
  blueTang,
  bronzeCorydoras,
  betta,
];

/** A 240 L show tank: 120 × 50 × 40 cm of water. */
export const SHOW_TANK = { width: 1.2, height: 0.5, depth: 0.4 } as const;
/** Tangs need a long, deep tank; a 20 cm fish in 40 cm of depth spends its life avoiding glass. */
export const REEF_TANK = { width: 1.8, height: 0.6, depth: 0.6 } as const;

export function spawnMany(species: string, count: number, prefix = species): FishSpawn[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, species }));
}

/** 60 fish, the desktop budget: a tetra school, cories, angelfish, tangs and a betta. */
export function benchmarkConfig(seed: number): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: ARCHETYPES,
    fish: [
      ...spawnMany('neon-tetra', 40),
      ...spawnMany('bronze-corydoras', 8),
      ...spawnMany('angelfish', 6),
      ...spawnMany('blue-tang', 5),
      ...spawnMany('betta', 1),
    ],
  };
}
