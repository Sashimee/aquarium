import { NEUTRAL_PERSONALITY, personalitySchema, type Personality } from '@aquarium/shared';
import type { FishResize } from './fishArrays.ts';
import { clamp } from './math.ts';

/**
 * How far each trait moves the behaviour it feeds, per unit of trait away from 0.5, so a trait of
 * 0 or 1 moves it by the full gain either way; sources are in BEHAVIOUR.md.
 */
export const PERSONALITY = {
  startleBoldnessShift: 0.2,
  shelterGain: 0.5,
  activityGain: 0.15,
  cohesionGain: 0.5,
  alignmentGain: 0.3,
  appetiteGain: 0.5,
  satiationGain: 0.8,
  competitionGain: 0.3,
} as const;

/** Checks a personality that may come from another thread; `who` names it in the error. */
export function parsePersonality(raw: unknown, who: string): Personality {
  const parsed = personalitySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RangeError(`${who}: personality ${issues.join('; ')}`);
  }
  return parsed.data;
}

function at(a: ArrayLike<number>, i: number): number {
  return a[i] ?? 0.5;
}

/** A trait as -1 (lowest) to 1 (highest), exactly 0 for the neutral 0.5. */
function centred(trait: number): number {
  return 2 * (trait - 0.5);
}

/**
 * Each fish's boldness, greed and sociability (0 to 1) and the factors they put on its steering.
 * Every factor is exactly 1, and the boldness exactly the species', for a neutral fish, so a tank
 * of neutral fish moves bit for bit as it would without personalities.
 */
export class Personalities {
  private _boldness: Float64Array;
  private _greed: Float64Array;
  private _sociability: Float64Array;

  get boldness(): Float64Array {
    return this._boldness;
  }

  get greed(): Float64Array {
    return this._greed;
  }

  get sociability(): Float64Array {
    return this._sociability;
  }

  constructor(count: number) {
    this._boldness = new Float64Array(count).fill(NEUTRAL_PERSONALITY.boldness);
    this._greed = new Float64Array(count).fill(NEUTRAL_PERSONALITY.greed);
    this._sociability = new Float64Array(count).fill(NEUTRAL_PERSONALITY.sociability);
  }

  /** A fish joining is neutral until it is given a personality. */
  resize(edit: FishResize): void {
    this._boldness = edit.array(this.boldness, 1, NEUTRAL_PERSONALITY.boldness);
    this._greed = edit.array(this.greed, 1, NEUTRAL_PERSONALITY.greed);
    this._sociability = edit.array(this.sociability, 1, NEUTRAL_PERSONALITY.sociability);
  }

  set(i: number, p: Personality): void {
    if (!(i >= 0 && i < this.boldness.length)) throw new RangeError(`no fish at index ${i}`);
    this.boldness[i] = p.boldness;
    this.greed[i] = p.greed;
    this.sociability[i] = p.sociability;
  }

  get(i: number): Personality {
    if (!(i >= 0 && i < this.boldness.length)) throw new RangeError(`no fish at index ${i}`);
    return {
      boldness: at(this.boldness, i),
      greed: at(this.greed, i),
      sociability: at(this.sociability, i),
    };
  }

  /** The species' boldness, shifted by the fish's own. */
  effectiveBoldness(i: number, speciesBoldness: number): number {
    const shift = PERSONALITY.startleBoldnessShift * centred(at(this.boldness, i));
    return clamp(speciesBoldness + shift, 0, 1);
  }

  /** Scales the time a cave dweller hides after a startle: shy fish stay in longer. */
  shelter(i: number): number {
    return 1 - PERSONALITY.shelterGain * centred(at(this.boldness, i));
  }

  /** Scales cruising speed: bold fish explore faster. */
  activity(i: number): number {
    return 1 + PERSONALITY.activityGain * centred(at(this.boldness, i));
  }

  /** Scales the pull towards schoolmates. */
  cohesion(i: number): number {
    return 1 + PERSONALITY.cohesionGain * centred(at(this.sociability, i));
  }

  /** Scales heading-matching with schoolmates. */
  alignment(i: number): number {
    return 1 + PERSONALITY.alignmentGain * centred(at(this.sociability, i));
  }

  /** Scales how strongly food in view draws the fish. */
  appetite(i: number): number {
    return 1 + PERSONALITY.appetiteGain * centred(at(this.greed, i));
  }

  /** Scales the hunger below which the fish stops feeding: greedy fish eat closer to full. */
  satiation(i: number): number {
    return 1 - PERSONALITY.satiationGain * centred(at(this.greed, i));
  }

  /**
   * Scales the distance the fish counts from contested food: claimants nearest it win, so a
   * greedy fish wins food a little farther off than a rival.
   */
  competition(i: number): number {
    return 1 - PERSONALITY.competitionGain * centred(at(this.greed, i));
  }
}
