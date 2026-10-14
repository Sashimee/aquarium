import { hashString } from './roster';

/** Another model of the same species, e.g. the other sex, drawn for `share` of its fish. */
export interface FishVariant {
  readonly assetId: string;
  readonly share: number;
}

export interface FishRenderProfile {
  readonly assetId: string;
  /** Alternatives to `assetId`; one sim species, so mixed groups still school together. */
  readonly variants: readonly FishVariant[];
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
}

const DEFAULTS: FishRenderProfile = {
  assetId: '',
  variants: [],
  iridescence: 0.25,
  iridescenceMask: 'body',
  filmThicknessNm: [250, 420],
  roughness: 0.4,
  finTransmission: 0.4,
  nightPaling: 0.4,
  tintVariation: 0.08,
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
    variants: [{ assetId: 'guppy-male', share: 0.5 }],
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
  'blue-tang': { ...DEFAULTS, assetId: 'blue-tang', iridescence: 0.2, finTransmission: 0.2 },
  'yellow-tang': { ...DEFAULTS, assetId: 'yellow-tang', iridescence: 0.1, finTransmission: 0.2 },
};

export function renderProfile(speciesId: string): FishRenderProfile {
  const profile = FISH_RENDER_PROFILES[speciesId];
  if (profile === undefined) {
    throw new Error(`no fish render profile for species "${speciesId}"; add it to profiles.ts`);
  }
  return profile;
}

/** The model one fish wears, chosen by its stable key so it keeps it across reloads. */
export function assetIdFor(profile: FishRenderProfile, fishKey: string): string {
  let u = hashString(`${fishKey}:variant`) / 2 ** 32;
  for (const variant of profile.variants) {
    if (u < variant.share) return variant.assetId;
    u -= variant.share;
  }
  return profile.assetId;
}

/** The instanced batch that draws a fish: one per species and model. */
export function batchKeyOf(fish: { readonly species: string; readonly key: string }): string {
  const profile = FISH_RENDER_PROFILES[fish.species];
  return `${fish.species}/${profile === undefined ? '' : assetIdFor(profile, fish.key)}`;
}
