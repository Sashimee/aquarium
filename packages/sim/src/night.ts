import type { Activity } from '@aquarium/shared';

/** Every tunable of the light-driven behaviour; sources are in BEHAVIOUR.md. */
export const NIGHT = {
  /** Below this light a diurnal fish settles for the night... */
  nightLight: 0.25,
  /** ...and above this one it wakes again. */
  dayLight: 0.35,
  /** Light strictly between these is dawn or dusk, when a crepuscular fish is fully awake. */
  twilightLow: 0.05,
  twilightHigh: 0.9,
  /** A crepuscular fish's rest level in full lamp light; it rests fully in the dark. */
  crepuscularDayRest: 0.4,
  /** How fast the eye adapts to a new light level; a change faster than this is a shock. */
  lightAdaptTauS: 1,
  /** Gap between the light and the adapted level that starts a startle... */
  lightStartleThreshold: 0.1,
  /** ...and the gap at which it is as strong as a tap next to the fish. */
  lightStartleFull: 0.6,
  /** Longest wait for the gap to peak before the startle fires anyway. */
  lightStartleWindowS: 0.5,
  /** Polyps follow the darkness with this time constant. */
  polypTauS: 300,
} as const;

const DT = 1 / 30;

/**
 * The tank's light as the fish see it: whether it is night, how strongly a sudden change startles
 * them, and how far coral polyps are out. Light set before the first step, or after `settle`, is
 * taken as already adapted to, so loading a tank or resuming a paused one in the dark startles
 * nothing. A loaded tank finds its polyps where the darkness puts them, a resumed one where the
 * pause spent in the current darkness has moved them.
 */
export class Night {
  private _light = 1;
  private _night = false;
  private adapted = 1;
  private _polyp = 0;
  private stepped = false;
  private armed = false;
  private rearmed = true;
  private peak = 0;
  private armedFor = 0;

  /** 0 = lights off, 1 = full day. */
  get light(): number {
    return this._light;
  }

  /** Lights off, with hysteresis between `nightLight` and `dayLight`. */
  get night(): boolean {
    return this._night;
  }

  /** How far coral polyps are extended, 0 (retracted) to 1 (fully out), from the darkness. */
  get polypExtension(): number {
    return this._polyp;
  }

  setLight(level: number): void {
    if (!(level >= 0 && level <= 1)) {
      throw new RangeError(`light level must be within [0, 1], got ${level}`);
    }
    this._light = level;
    this.updateNight();
    if (!this.stepped) {
      this.settle();
      this._polyp = 1 - level;
    }
  }

  /**
   * Takes the current light as already adapted to, so it startles nobody, and eases the polyps as
   * far as `pausedS` seconds of the current darkness would have.
   */
  settle(pausedS = 0): void {
    if (!(pausedS >= 0)) {
      throw new RangeError(`paused time must be at least 0 s, got ${pausedS}`);
    }
    this.adapted = this._light;
    this.armed = false;
    this.rearmed = true;
    this._polyp += (1 - this._light - this._polyp) * (1 - Math.exp(-pausedS / NIGHT.polypTauS));
  }

  /**
   * Advances one step. Returns the strength of the light startle that fires now, 0 to 1, or 0.
   * The startle waits for the gap between the light and the eye's adapted level to stop growing
   * (at most `lightStartleWindowS`), so a short ramp is judged by its steepest part and fires once.
   */
  step(): number {
    this.stepped = true;
    this.updateNight();
    const gap = Math.abs(this._light - this.adapted);
    let fired = 0;
    if (this.armed) {
      this.armedFor += DT;
      if (gap > this.peak && this.armedFor < NIGHT.lightStartleWindowS) {
        this.peak = gap;
      } else {
        fired = Math.max(this.peak, gap);
        this.armed = false;
        this.rearmed = false;
      }
    } else if (this.rearmed && gap > NIGHT.lightStartleThreshold) {
      this.armed = true;
      this.armedFor = 0;
      this.peak = gap;
    }
    if (!this.armed && gap < NIGHT.lightStartleThreshold / 2) this.rearmed = true;
    this.adapted += (this._light - this.adapted) * (1 - Math.exp(-DT / NIGHT.lightAdaptTauS));
    this._polyp += (1 - this._light - this._polyp) * (1 - Math.exp(-DT / NIGHT.polypTauS));
    if (fired === 0) return 0;
    const span = NIGHT.lightStartleFull - NIGHT.lightStartleThreshold;
    return Math.min(1, (fired - NIGHT.lightStartleThreshold) / span);
  }

  /** The rest level a fish of `activity` settles towards under the current light. */
  restTarget(activity: Activity): number {
    switch (activity) {
      case 'diurnal':
        return this._night ? 1 : 0;
      case 'nocturnal':
        return this._night ? 0 : 1;
      case 'crepuscular': {
        const l = this._light;
        if (l > NIGHT.twilightLow && l < NIGHT.twilightHigh) return 0;
        return l >= NIGHT.twilightHigh ? NIGHT.crepuscularDayRest : 1;
      }
    }
  }

  /** Whether a fish of `activity` resting now is resting in lamp light, its day off. */
  restsInLight(activity: Activity): boolean {
    return activity === 'nocturnal' && !this._night;
  }

  private updateNight(): void {
    if (this._light < NIGHT.nightLight) this._night = true;
    else if (this._light > NIGHT.dayLight) this._night = false;
  }
}
