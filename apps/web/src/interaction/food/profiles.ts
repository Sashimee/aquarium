import { foodTypeSchema, type FoodType } from '@aquarium/shared';

export interface FoodProfile {
  /** Particles spawned per unit of portion. */
  readonly particlesPerPortion: number;
  /** Still-water sink speed in m/s once the particle is waterlogged. */
  readonly sinkSpeed: number;
  /** Seconds the particle rides the surface before it starts to sink; 0 sinks at once. */
  readonly floatS: number;
  /** How quickly the particle's velocity relaxes toward water velocity plus sink, in seconds. */
  readonly responseS: number;
  /** Fraction of the current's speed the particle takes up (light food is pushed more). */
  readonly currentGain: number;
  /** Horizontal drift saturates smoothly toward this speed (m/s), so current never carries food faster than the slowest eater can follow it. */
  readonly maxDriftS: number;
  /** Seconds the settled particle lasts before it dissolves. */
  readonly decayS: number;
  /** Particle radius in metres, used by the renderer. */
  readonly radius: number;
}

export const FOOD_PROFILES: Readonly<Record<FoodType, FoodProfile>> = {
  flakes: {
    particlesPerPortion: 18,
    sinkSpeed: 0.01,
    floatS: 25,
    responseS: 0.6,
    currentGain: 0.3,
    maxDriftS: 0.014,
    decayS: 90,
    radius: 0.0032,
  },
  pellets: {
    particlesPerPortion: 8,
    sinkSpeed: 0.03,
    floatS: 0,
    responseS: 0.25,
    currentGain: 0.1,
    maxDriftS: 0.012,
    decayS: 180,
    radius: 0.0028,
  },
  bloodworms: {
    particlesPerPortion: 6,
    sinkSpeed: 0.02,
    floatS: 0,
    responseS: 0.35,
    currentGain: 0.15,
    maxDriftS: 0.018,
    decayS: 150,
    radius: 0.0035,
  },
  'brine-shrimp': {
    particlesPerPortion: 20,
    sinkSpeed: 0.008,
    floatS: 0,
    responseS: 0.8,
    currentGain: 0.3,
    maxDriftS: 0.014,
    decayS: 60,
    radius: 0.0018,
  },
  nori: {
    particlesPerPortion: 2,
    sinkSpeed: 0.02,
    floatS: 40,
    responseS: 0.7,
    currentGain: 0.5,
    maxDriftS: 0.09,
    decayS: 420,
    radius: 0.011,
  },
  'algae-wafer': {
    particlesPerPortion: 1,
    sinkSpeed: 0.07,
    floatS: 0,
    responseS: 0.2,
    currentGain: 0.04,
    maxDriftS: 0.02,
    decayS: 900,
    radius: 0.012,
  },
};

/** The shared food vocabulary in its declared order: the sim's `typeIndex`. */
export const FOOD_TYPES: readonly FoodType[] = foodTypeSchema.options;

export function foodTypeIndex(food: FoodType): number {
  return FOOD_TYPES.indexOf(food);
}
