import type { FishStage } from '@aquarium/shared';

export interface FryGrowth {
  readonly juvenileAfterDays: number;
  readonly adultAfterDays: number;
}

export interface SpeciesGrowth {
  readonly birthSizeM: number;
  /** Undefined for a species that never breeds; its young are bought, not born. */
  readonly fryGrowth: FryGrowth | undefined;
}

const DAY_MS = 86_400_000;
/** Where a juvenile of a species without fry growth data sits between birth and adulthood. */
const JUVENILE_MATURITY = 0.5;

/**
 * 0 newborn .. 1 adult. Age places a young fish along its species' `fryGrowth`, kept inside the
 * band of the stage the server gave it; a fish of unknown age, or of a species without fry
 * growth, sits at the start of its stage. Null stage (demo fish) and adults are fully grown. The
 * juvenile band runs up to 1: a fish past `adultAfterDays` is grown even if the server's next
 * lifecycle step has not promoted it yet.
 */
export function maturityOf(
  stage: FishStage | null,
  ageDays: number,
  growth: FryGrowth | undefined,
): number {
  if (stage === null || stage === 'adult') return 1;
  if (growth === undefined) return stage === 'fry' ? 0 : JUVENILE_MATURITY;
  const juvenileFrom = growth.juvenileAfterDays / growth.adultAfterDays;
  const [lo, hi] = stage === 'fry' ? [0, juvenileFrom] : [juvenileFrom, 1];
  if (!Number.isFinite(ageDays)) return lo;
  return Math.min(hi, Math.max(lo, ageDays / growth.adultAfterDays));
}

/** Days since `bornAtMs`; NaN when either time is unknown. */
export function ageDaysAt(bornAtMs: number, nowMs: number): number {
  return (nowMs - bornAtMs) / DAY_MS;
}

/**
 * How far a fish's livery is from its adult colour, 0 adult .. 1 newborn, as the shaders read it.
 * Fry are near-transparent and their chromatophores fill in through the juvenile stage, so the
 * colour comes in slowly at first and settles as the fish nears adulthood.
 */
export function youthOf(maturity: number): number {
  const m = Number.isFinite(maturity) ? Math.min(1, Math.max(0, maturity)) : 1;
  return 1 - m * m * (3 - 2 * m);
}

/**
 * Body length in metres: the server's `size`, which the lifecycle grows from the species'
 * `birthSizeM`. Without a usable size, a young fish is placed between `birthSizeM` and the adult
 * length by its stage alone.
 */
export function lengthByStageM(
  sizeM: number | undefined,
  stage: FishStage | null,
  growth: SpeciesGrowth | undefined,
  adultLengthM: number,
): number {
  if (sizeM !== undefined && Number.isFinite(sizeM) && sizeM > 0) return sizeM;
  if (growth === undefined) return adultLengthM;
  const birth = Math.min(growth.birthSizeM, adultLengthM);
  return birth + (adultLengthM - birth) * maturityOf(stage, NaN, growth.fryGrowth);
}
