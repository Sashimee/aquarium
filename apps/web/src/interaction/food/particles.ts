import type { FoodType } from '@aquarium/shared';
import { FOOD_PROFILES, foodTypeIndex } from './profiles';

export interface FoodBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly waterTop: number;
}

export interface FoodEnvironment {
  readonly bounds: FoodBounds;
  /** Visible sand height at (x, z), in scene space. */
  groundHeight(x: number, z: number): number;
  /** Writes the water velocity in m/s into `out`. */
  current(x: number, y: number, z: number, out: Float64Array | number[]): void;
}

export interface FoodParticle {
  readonly id: number;
  readonly food: FoodType;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Negative while the particle is still held back after being dropped. */
  ageS: number;
  /** Seconds since touching the floor, or -1 while still falling. */
  settledS: number;
}

export const MAX_FOOD_PARTICLES = 400;
export const FOOD_STRIDE = 5;
const MAX_STEP_S = 0.1;
const SURFACE_MARGIN = 0.002;
const WALL_MARGIN = 0.004;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Food particles in scene space, stepped on the main thread. */
export class FoodField {
  private readonly list: FoodParticle[] = [];
  private nextId = 1;
  private readonly flow = new Float64Array(3);

  constructor(
    private readonly env: FoodEnvironment,
    private readonly random: () => number = Math.random,
  ) {}

  get particles(): readonly FoodParticle[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  /**
   * Scatters a portion around (x, z) at the water surface. Returns how many particles were made,
   * which is fewer than asked when the tank already holds the cap of uneaten food.
   */
  drop(food: FoodType, portion: number, x: number, z: number, spread = 0.03): number {
    if (!(portion > 0)) throw new RangeError(`drop: portion must be positive, got ${portion}`);
    const profile = FOOD_PROFILES[food];
    const wanted = Math.max(1, Math.round(profile.particlesPerPortion * portion));
    const made = Math.min(wanted, MAX_FOOD_PARTICLES - this.list.length);
    const { bounds } = this.env;
    for (let i = 0; i < made; i++) {
      const angle = this.random() * Math.PI * 2;
      const radius = spread * Math.sqrt(this.random());
      this.list.push({
        id: this.nextId++,
        food,
        x: clamp(
          x + Math.cos(angle) * radius,
          bounds.minX + WALL_MARGIN,
          bounds.maxX - WALL_MARGIN,
        ),
        y: bounds.waterTop - SURFACE_MARGIN - this.random() * 0.004,
        z: clamp(
          z + Math.sin(angle) * radius,
          bounds.minZ + WALL_MARGIN,
          bounds.maxZ - WALL_MARGIN,
        ),
        vx: 0,
        vy: 0,
        vz: 0,
        ageS: -this.random() * 0.4,
        settledS: -1,
      });
    }
    return made;
  }

  /** Removes particles by id (eaten); unknown ids are ignored. Returns the ones removed. */
  remove(ids: Iterable<number>): FoodParticle[] {
    const doomed = new Set(ids);
    if (doomed.size === 0) return [];
    const removed: FoodParticle[] = [];
    let keep = 0;
    for (const p of this.list) {
      if (doomed.has(p.id)) removed.push(p);
      else this.list[keep++] = p;
    }
    this.list.length = keep;
    return removed;
  }

  clear(): void {
    this.list.length = 0;
  }

  /** Advances every particle and returns the settled ones that dissolved this step. */
  step(deltaS: number): FoodParticle[] {
    if (!(deltaS >= 0)) throw new RangeError(`step: deltaS must be >= 0, got ${deltaS}`);
    const dt = Math.min(deltaS, MAX_STEP_S);
    const expired: FoodParticle[] = [];
    if (dt === 0) return expired;
    let keep = 0;
    for (const p of this.list) {
      this.advance(p, dt);
      if (p.settledS >= FOOD_PROFILES[p.food].decayS) expired.push(p);
      else this.list[keep++] = p;
    }
    this.list.length = keep;
    return expired;
  }

  /** Packs `[id, x, y, z, typeIndex]` per particle for the sim, positions mapped by `toSim`. */
  pack(toSim: (x: number, y: number, z: number, out: Float64Array) => void): Float32Array {
    const result = new Float32Array(this.list.length * FOOD_STRIDE);
    const sim = new Float64Array(3);
    this.list.forEach((p, i) => {
      toSim(p.x, p.y, p.z, sim);
      const o = i * FOOD_STRIDE;
      result[o] = p.id;
      result[o + 1] = sim[0] ?? 0;
      result[o + 2] = sim[1] ?? 0;
      result[o + 3] = sim[2] ?? 0;
      result[o + 4] = foodTypeIndex(p.food);
    });
    return result;
  }

  private advance(p: FoodParticle, dt: number): void {
    p.ageS += dt;
    if (p.ageS < 0) return;
    if (p.settledS >= 0) {
      p.settledS += dt;
      return;
    }
    const profile = FOOD_PROFILES[p.food];
    const { bounds } = this.env;
    const floating = p.ageS < profile.floatS;
    this.env.current(p.x, p.y, p.z, this.flow);
    const gain = profile.currentGain;
    const targetVy = floating ? 0 : -profile.sinkSpeed + (this.flow[1] ?? 0) * gain;
    const k = 1 - Math.exp(-dt / profile.responseS);
    p.vx += ((this.flow[0] ?? 0) * gain - p.vx) * k;
    p.vy += (targetVy - p.vy) * k;
    p.vz += ((this.flow[2] ?? 0) * gain - p.vz) * k;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    const loX = bounds.minX + WALL_MARGIN;
    const hiX = bounds.maxX - WALL_MARGIN;
    const loZ = bounds.minZ + WALL_MARGIN;
    const hiZ = bounds.maxZ - WALL_MARGIN;
    if (p.x < loX || p.x > hiX) {
      p.x = clamp(p.x, loX, hiX);
      p.vx = 0;
    }
    if (p.z < loZ || p.z > hiZ) {
      p.z = clamp(p.z, loZ, hiZ);
      p.vz = 0;
    }
    const top = bounds.waterTop - SURFACE_MARGIN;
    if (p.y > top) {
      p.y = top;
      p.vy = 0;
    }
    const floor = this.env.groundHeight(p.x, p.z);
    if (p.y <= floor) {
      p.y = floor;
      p.vx = p.vy = p.vz = 0;
      p.settledS = 0;
    }
  }
}
