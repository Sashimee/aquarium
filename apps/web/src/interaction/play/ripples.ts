import type { Vec3 } from '../camera';

export interface Ripple {
  readonly origin: Vec3;
  /** Unit normal of the surface the ripple lies on, pointing into the tank. */
  readonly normal: Vec3;
  readonly strength: number;
  ageS: number;
}

export const RIPPLE_DURATION_S = 1.4;
export const MAX_RIPPLES = 8;
const MAX_RADIUS_M = 0.14;

/** Expanding ring state; `radius` and `opacity` are what the renderer draws. */
export class RippleField {
  private readonly list: Ripple[] = [];

  get ripples(): readonly Ripple[] {
    return this.list;
  }

  add(origin: Vec3, normal: Vec3, strength: number): void {
    if (this.list.length >= MAX_RIPPLES) this.list.shift();
    this.list.push({ origin, normal, strength, ageS: 0 });
  }

  step(deltaS: number): void {
    let keep = 0;
    for (const r of this.list) {
      r.ageS += deltaS;
      if (r.ageS < RIPPLE_DURATION_S) this.list[keep++] = r;
    }
    this.list.length = keep;
  }

  static radius(r: Ripple): number {
    const t = Math.min(1, r.ageS / RIPPLE_DURATION_S);
    return MAX_RADIUS_M * (0.4 + 0.6 * r.strength) * (1 - (1 - t) * (1 - t));
  }

  static opacity(r: Ripple): number {
    const t = Math.min(1, r.ageS / RIPPLE_DURATION_S);
    return 0.5 * r.strength * (1 - t) * (1 - t);
  }
}
