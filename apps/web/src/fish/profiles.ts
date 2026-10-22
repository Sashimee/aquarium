import type { FishSex, FishStage } from '@aquarium/shared';
import { lengthByStageM } from './maturity';
import { hashString } from './roster';
import { speciesGrowth } from './species';
import type { SwimModeParams } from './swim';

/** `sex` is the server's stored one; null for demo fish, which have no server record. */
export interface SexedFish {
  readonly key: string;
  readonly sex: FishSex | null;
}

/** The model one fish wears, and its standard length over the species' (female) one. */
export interface FishModelChoice {
  readonly assetId: string;
  /** Must match the asset recipe's `lengthFactor`, which the model was scaled by. */
  readonly lengthFactor: number;
}

export interface FishRenderProfile {
  readonly assetId: string;
  /** The model males wear instead; one sim species, so mixed groups still school together. */
  readonly male: FishModelChoice | null;
  /** Guanine-platelet iridescence strength on the body, 0..1. */
  readonly iridescence: number;
  /** `blue` limits iridescence to blue-dominant texels, e.g. the neon tetra's stripe. */
  readonly iridescenceMask: 'body' | 'blue';
  /** Iridescent film thickness range in nm; each fish picks a value inside it. */
  readonly filmThicknessNm: readonly [number, number];
  readonly roughness: number;
  /** How much light passes through fin membranes, 0 opaque .. 1 clear. */
  readonly finTransmission: number;
  /** How strongly the colours pale at night, 0..1. */
  readonly nightPaling: number;
  /** Per-fish brightness and hue variation, 0..1. */
  readonly tintVariation: number;
  /** Scales on the swimming mode's amplitudes, for a body or fins stiffer or longer than usual. */
  readonly swim: SwimTuning;
}

export interface SwimTuning {
  readonly bodyWave: number;
  readonly pectoral: number;
  readonly medianFin: number;
}

const DEFAULTS: FishRenderProfile = {
  assetId: '',
  male: null,
  iridescence: 0.25,
  iridescenceMask: 'body',
  filmThicknessNm: [250, 420],
  roughness: 0.4,
  finTransmission: 0.4,
  nightPaling: 0.4,
  tintVariation: 0.08,
  swim: { bodyWave: 1, pectoral: 1, medianFin: 1 },
};

/**
 * Neon tetras pale markedly at night as their iridophores reorient (Lythgoe & Shand 1982); the
 * stripe is a thin-film reflector, hence the strong blue-masked iridescence.
 */
export const FISH_RENDER_PROFILES: Readonly<Record<string, FishRenderProfile>> = {
  'neon-tetra': {
    ...DEFAULTS,
    assetId: 'neon-tetra',
    iridescence: 1,
    iridescenceMask: 'blue',
    filmThicknessNm: [300, 380],
    roughness: 0.3,
    finTransmission: 0.7,
    nightPaling: 0.85,
    tintVariation: 0.05,
  },
  angelfish: {
    ...DEFAULTS,
    assetId: 'angelfish',
    iridescence: 0.35,
    finTransmission: 0.45,
  },
  'bronze-corydoras': {
    ...DEFAULTS,
    assetId: 'bronze-corydoras',
    iridescence: 0.5,
    filmThicknessNm: [380, 520],
    finTransmission: 0.55,
    nightPaling: 0.2,
  },
  betta: {
    ...DEFAULTS,
    assetId: 'betta',
    iridescence: 0.45,
    iridescenceMask: 'blue',
    finTransmission: 0.3,
    nightPaling: 0.3,
    tintVariation: 0.12,
  },
  guppy: {
    ...DEFAULTS,
    assetId: 'guppy-female',
    male: { assetId: 'guppy-male', lengthFactor: 0.625 },
    iridescence: 0.3,
    finTransmission: 0.6,
    tintVariation: 0.1,
  },
  'banggai-cardinalfish': {
    ...DEFAULTS,
    assetId: 'banggai-cardinalfish',
    iridescence: 0.15,
    finTransmission: 0.5,
  },
  'ocellaris-clownfish': { ...DEFAULTS, assetId: 'ocellaris-clownfish', iridescence: 0.1 },
  'royal-gramma': { ...DEFAULTS, assetId: 'royal-gramma', iridescence: 0.2 },
  'cleaner-wrasse': {
    ...DEFAULTS,
    assetId: 'cleaner-wrasse',
    iridescence: 0.25,
    roughness: 0.35,
    finTransmission: 0.5,
    nightPaling: 0.3,
  },
  'blue-tang': { ...DEFAULTS, assetId: 'blue-tang', iridescence: 0.2, finTransmission: 0.2 },
  'yellow-tang': { ...DEFAULTS, assetId: 'yellow-tang', iridescence: 0.1, finTransmission: 0.2 },
  // Discus hold the deep, compressed disc nearly rigid and scull with the long dorsal and anal fins.
  discus: {
    ...DEFAULTS,
    assetId: 'discus',
    iridescence: 0.35,
    roughness: 0.35,
    finTransmission: 0.3,
    nightPaling: 0.5,
    swim: { bodyWave: 0.6, pectoral: 0.8, medianFin: 1.4 },
  },
  // Armoured in bony scutes, no guanine sheen; a nocturnal grazer that does not pale at night.
  'bristlenose-pleco': {
    ...DEFAULTS,
    assetId: 'bristlenose-pleco',
    iridescence: 0,
    roughness: 0.65,
    finTransmission: 0.15,
    nightPaling: 0.1,
    tintVariation: 0.1,
    swim: { bodyWave: 0.6, pectoral: 0.4, medianFin: 0.3 },
  },
  'harlequin-rasbora': {
    ...DEFAULTS,
    assetId: 'harlequin-rasbora',
    iridescence: 0.3,
    roughness: 0.35,
    finTransmission: 0.6,
    nightPaling: 0.5,
  },
  'six-line-wrasse': {
    ...DEFAULTS,
    assetId: 'six-line-wrasse',
    iridescence: 0.25,
    roughness: 0.35,
    finTransmission: 0.5,
    nightPaling: 0.3,
  },
  firefish: {
    ...DEFAULTS,
    assetId: 'firefish',
    iridescence: 0.1,
    finTransmission: 0.55,
    nightPaling: 0.3,
  },
  // Shrimp colour sits in chromatophores under a clear chitin shell: a glossy surface with no
  // guanine sheen, and thin limbs that let light through. Neocaridina fade sharply when stressed.
  'cherry-shrimp': {
    ...DEFAULTS,
    assetId: 'cherry-shrimp',
    iridescence: 0,
    roughness: 0.3,
    finTransmission: 0.5,
    nightPaling: 0.3,
    tintVariation: 0.12,
  },
  'cleaner-shrimp': {
    ...DEFAULTS,
    assetId: 'cleaner-shrimp',
    iridescence: 0,
    roughness: 0.3,
    finTransmission: 0.4,
    nightPaling: 0.2,
  },
  // A glossy calcite shell with no thin-film sheen; the "fin" here is the translucent foot.
  'nerite-snail': {
    ...DEFAULTS,
    assetId: 'nerite-snail',
    iridescence: 0,
    roughness: 0.35,
    finTransmission: 0.3,
    nightPaling: 0.05,
    tintVariation: 0.06,
  },
  // A matte borrowed shell over a chitin body; crabs change colour over moults, not at night.
  'hermit-crab': {
    ...DEFAULTS,
    assetId: 'hermit-crab',
    iridescence: 0,
    roughness: 0.5,
    finTransmission: 0.2,
    nightPaling: 0.1,
    tintVariation: 0.08,
  },
  // The cardinal's stripe is the same iridophore reflector as the neon's, and pales at night too.
  'cardinal-tetra': {
    ...DEFAULTS,
    assetId: 'cardinal-tetra',
    iridescence: 1,
    iridescenceMask: 'blue',
    filmThicknessNm: [300, 380],
    roughness: 0.3,
    finTransmission: 0.7,
    nightPaling: 0.85,
    tintVariation: 0.05,
  },
  'rummy-nose-tetra': {
    ...DEFAULTS,
    assetId: 'rummy-nose-tetra',
    iridescence: 0.35,
    roughness: 0.35,
    finTransmission: 0.65,
    nightPaling: 0.6,
  },
  'dwarf-pencilfish': {
    ...DEFAULTS,
    assetId: 'dwarf-pencilfish',
    male: { assetId: 'dwarf-pencilfish-male', lengthFactor: 1 },
    iridescence: 0.2,
    finTransmission: 0.6,
    nightPaling: 0.5,
  },
  // Apistogramma males grow about two thirds longer than females (FishBase: 7 cm vs ~4 cm TL).
  'apistogramma-hongsloi': {
    ...DEFAULTS,
    assetId: 'apistogramma-hongsloi',
    male: { assetId: 'apistogramma-hongsloi-male', lengthFactor: 0.05 / 0.03 },
    iridescence: 0.3,
    finTransmission: 0.45,
    nightPaling: 0.4,
    tintVariation: 0.12,
  },
};

export function renderProfile(speciesId: string): FishRenderProfile {
  const profile = FISH_RENDER_PROFILES[speciesId];
  if (profile === undefined) {
    throw new Error(`no fish render profile for species "${speciesId}"; add it to profiles.ts`);
  }
  return profile;
}

/** The swimming mode with the species' amplitude scales applied. */
export function swimModeFor(mode: SwimModeParams, profile: FishRenderProfile): SwimModeParams {
  const { swim } = profile;
  return {
    ...mode,
    bodyWave: mode.bodyWave * swim.bodyWave,
    pectoral: mode.pectoral * swim.pectoral,
    medianFin: mode.medianFin * swim.medianFin,
  };
}

/**
 * The stored sex, or for a demo fish one drawn from its key alone, never from a profile, so
 * editing the models can't flip it. Even 1:1, and the same draw the server backfilled saved fish
 * with. A species without a male model draws both sexes with its one model at full length.
 */
export function sexOf(fish: SexedFish): FishSex {
  if (fish.sex !== null) return fish.sex;
  return hashString(`${fish.key}:variant`) < 2 ** 31 ? 'male' : 'female';
}

export function modelFor(profile: FishRenderProfile, fish: SexedFish): FishModelChoice {
  if (profile.male !== null && sexOf(fish) === 'male') return profile.male;
  return { assetId: profile.assetId, lengthFactor: 1 };
}

/**
 * In metres: the fish's size, or else a length for its stage up to the species' adult length,
 * scaled for its sex. Sizes are on the species' (female) scale, so a guppy male is drawn and
 * simulated smaller than its size.
 */
export function bodyLengthOf(
  fish: SexedFish & {
    readonly species: string;
    readonly lengthM: number | undefined;
    readonly stage: FishStage | null;
  },
  speciesLengthM: number,
): number {
  const profile = FISH_RENDER_PROFILES[fish.species];
  const factor = profile === undefined ? 1 : modelFor(profile, fish).lengthFactor;
  const length = lengthByStageM(
    fish.lengthM,
    fish.stage,
    speciesGrowth(fish.species),
    speciesLengthM,
  );
  return length * factor;
}

/** The instanced batch that draws a fish: one per species and model. */
export function batchKeyOf(fish: SexedFish & { readonly species: string }): string {
  const profile = FISH_RENDER_PROFILES[fish.species];
  return `${fish.species}/${profile === undefined ? '' : modelFor(profile, fish).assetId}`;
}
