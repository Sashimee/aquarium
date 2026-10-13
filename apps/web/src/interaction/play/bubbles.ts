export interface Bubble {
  x: number;
  y: number;
  z: number;
  radius: number;
  ageS: number;
  phase: number;
}

export const MAX_BUBBLES = 160;
const BASE_RISE_MPS = 0.18;
const WOBBLE_AMPLITUDE_M = 0.004;
const WOBBLE_HZ = 2.4;

/** Rising bubbles from the wand. Larger bubbles rise faster, and all of them pop at the surface. */
export class BubbleField {
  private readonly list: Bubble[] = [];

  constructor(
    private readonly waterTop: number,
    private readonly random: () => number = Math.random,
  ) {}

  get bubbles(): readonly Bubble[] {
    return this.list;
  }

  emit(x: number, y: number, z: number, count = 1): number {
    const made = Math.min(count, MAX_BUBBLES - this.list.length);
    for (let i = 0; i < made; i++) {
      this.list.push({
        x: x + (this.random() - 0.5) * 0.01,
        y,
        z: z + (this.random() - 0.5) * 0.01,
        radius: 0.002 + this.random() * 0.004,
        ageS: 0,
        phase: this.random() * Math.PI * 2,
      });
    }
    return made;
  }

  step(deltaS: number): void {
    if (!(deltaS >= 0)) throw new RangeError(`step: deltaS must be >= 0, got ${deltaS}`);
    let keep = 0;
    for (const b of this.list) {
      b.ageS += deltaS;
      b.y += BASE_RISE_MPS * (0.6 + b.radius * 150) * deltaS;
      if (b.y < this.waterTop) this.list[keep++] = b;
    }
    this.list.length = keep;
  }

  /** Horizontal sway so a column of bubbles does not rise as a straight line. */
  static wobble(b: Bubble, out: { dx: number; dz: number }): void {
    const a = b.ageS * WOBBLE_HZ * Math.PI * 2 + b.phase;
    out.dx = Math.sin(a) * WOBBLE_AMPLITUDE_M;
    out.dz = Math.cos(a * 0.8) * WOBBLE_AMPLITUDE_M;
  }
}
