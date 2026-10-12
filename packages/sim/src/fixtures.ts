import type { Anchor } from './behaviour.ts';
import type { DecorCollider } from './decor.ts';
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
    traits: ['shoal', 'air-gulp'],
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
    traits: ['flare-display'],
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

export const yellowTang: SpeciesInput = {
  id: 'yellow-tang',
  behaviour: {
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.15, 0.85],
    perceptionRangeM: 0.7,
    perceptionFovDeg: 300,
    curiosity: 0.5,
    boldness: 0.6,
    traits: ['rock-grazer'],
  },
  locomotion: {
    swimmingMode: 'labriform',
    gait: 'cruise',
    maxSpeedMps: 1,
    cruiseSpeedMps: 0.2,
    massKg: 0.12,
    maxTurnRateDegPerS: 270,
    maxPitchDeg: 30,
    strouhal: 0.3,
    bodyLengthM: 0.15,
  },
};

export const clownfish: SpeciesInput = {
  id: 'ocellaris-clownfish',
  behaviour: {
    territorial: true,
    preferredZone: 'mid',
    depthBand: [0.1, 0.7],
    perceptionRangeM: 0.4,
    perceptionFovDeg: 300,
    curiosity: 0.5,
    boldness: 0.7,
    traits: ['anemone-host'],
  },
  locomotion: {
    swimmingMode: 'labriform',
    gait: 'hover',
    maxSpeedMps: 0.6,
    cruiseSpeedMps: 0.08,
    massKg: 0.01,
    maxTurnRateDegPerS: 360,
    maxPitchDeg: 30,
    strouhal: 0.3,
    bodyLengthM: 0.08,
  },
};

export const royalGramma: SpeciesInput = {
  id: 'royal-gramma',
  behaviour: {
    territorial: true,
    preferredZone: 'bottom',
    depthBand: [0.1, 0.6],
    perceptionRangeM: 0.4,
    perceptionFovDeg: 300,
    curiosity: 0.5,
    boldness: 0.4,
    traits: ['cave-dweller'],
  },
  locomotion: {
    swimmingMode: 'labriform',
    gait: 'hover',
    maxSpeedMps: 0.5,
    cruiseSpeedMps: 0.04,
    massKg: 0.006,
    maxTurnRateDegPerS: 360,
    maxPitchDeg: 60,
    strouhal: 0.3,
    bodyLengthM: 0.07,
  },
};

/** Not in the shipped roster: the glass-grazer archetype (Otocinclus). */
export const otocinclus: SpeciesInput = {
  id: 'otocinclus',
  behaviour: {
    schooling: { minGroup: 3, topologicalNeighbours: 4, tightenWhenStartled: false },
    territorial: false,
    preferredZone: 'mid',
    depthBand: [0.1, 0.9],
    perceptionRangeM: 0.2,
    perceptionFovDeg: 300,
    curiosity: 0.3,
    boldness: 0.3,
    traits: ['shoal', 'glass-grazer'],
  },
  locomotion: {
    swimmingMode: 'subcarangiform',
    gait: 'hover',
    maxSpeedMps: 0.3,
    cruiseSpeedMps: 0.03,
    massKg: 0.001,
    maxTurnRateDegPerS: 360,
    maxPitchDeg: 80,
    strouhal: 0.3,
    bodyLengthM: 0.04,
  },
};

export const ARCHETYPES: readonly SpeciesInput[] = [
  neonTetra,
  angelfish,
  blueTang,
  bronzeCorydoras,
  betta,
  yellowTang,
  clownfish,
  royalGramma,
  otocinclus,
];

/** A 240 L show tank: 120 × 50 × 40 cm of water. */
export const SHOW_TANK = { width: 1.2, height: 0.5, depth: 0.4 } as const;
/** Tangs need a long, deep tank; a 20 cm fish in 40 cm of depth spends its life avoiding glass. */
export const REEF_TANK = { width: 1.8, height: 0.6, depth: 0.6 } as const;

/** Live rock, a three-stone cave and an anemone over the reef tank's sand. */
export const REEF_DECOR: readonly DecorCollider[] = [
  {
    id: 'rock-left',
    solid: true,
    shape: { kind: 'sphere', center: [-0.55, 0, -0.1], radius: 0.2 },
  },
  {
    id: 'rock-right',
    solid: true,
    shape: {
      kind: 'box',
      center: [0.55, 0.1, -0.12],
      halfExtents: [0.18, 0.1, 0.1],
      rotationY: 0.3,
      rounding: 0.03,
    },
  },
  {
    id: 'cave-west',
    solid: true,
    shape: { kind: 'box', center: [0.05, 0.06, -0.18], halfExtents: [0.03, 0.06, 0.07] },
  },
  {
    id: 'cave-east',
    solid: true,
    shape: { kind: 'box', center: [0.25, 0.06, -0.18], halfExtents: [0.03, 0.06, 0.07] },
  },
  {
    id: 'cave-roof',
    solid: true,
    shape: {
      kind: 'box',
      center: [0.15, 0.135, -0.18],
      halfExtents: [0.15, 0.015, 0.09],
      rounding: 0.01,
    },
  },
  {
    id: 'anemone',
    solid: false,
    shape: { kind: 'sphere', center: [-0.2, 0.03, 0.08], radius: 0.07 },
  },
  {
    id: 'sea-grass',
    solid: false,
    shape: { kind: 'capsule', a: [0.7, 0, 0.2], b: [0.7, 0.3, 0.2], radius: 0.03 },
  },
];

export const REEF_ANCHORS: readonly Anchor[] = [
  { id: 'anemone', kind: 'anemone', position: [-0.2, 0.08, 0.08], radius: 0.07 },
  { id: 'cave', kind: 'cave', position: [0.15, 0.06, -0.18], radius: 0.05, facing: [0, 0, 1] },
];

/** Driftwood, a stone and a stand of plants in the freshwater show tank. */
export const SHOW_DECOR: readonly DecorCollider[] = [
  {
    id: 'driftwood',
    solid: true,
    shape: { kind: 'capsule', a: [-0.4, 0.03, -0.05], b: [0.1, 0.18, -0.12], radius: 0.035 },
  },
  { id: 'stone', solid: true, shape: { kind: 'sphere', center: [0.35, 0, 0.05], radius: 0.12 } },
  {
    id: 'vallisneria-1',
    solid: false,
    shape: { kind: 'capsule', a: [-0.45, 0, 0.12], b: [-0.45, 0.35, 0.12], radius: 0.025 },
  },
  {
    id: 'vallisneria-2',
    solid: false,
    shape: { kind: 'capsule', a: [-0.35, 0, 0.14], b: [-0.33, 0.32, 0.14], radius: 0.025 },
  },
];

export function spawnMany(species: string, count: number, prefix = species): FishSpawn[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, species }));
}

/**
 * 60 fish, the desktop budget, in the decorated reef tank: a tetra school, cories, angelfish,
 * tangs, a clownfish pair, a royal gramma and a betta.
 */
export function benchmarkConfig(seed: number): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: ARCHETYPES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish: [
      ...spawnMany('neon-tetra', 40),
      ...spawnMany('bronze-corydoras', 8),
      ...spawnMany('angelfish', 4),
      ...spawnMany('blue-tang', 2),
      ...spawnMany('yellow-tang', 2),
      ...spawnMany('ocellaris-clownfish', 2),
      ...spawnMany('royal-gramma', 1),
      ...spawnMany('betta', 1),
    ],
  };
}
