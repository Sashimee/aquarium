/**
 * Signed distance to the nearest surface a fish may not cross: positive in free water, negative
 * inside geometry. `sample` writes the unit gradient (pointing into free water) to `normal`.
 */
export interface Sdf {
  sample(x: number, y: number, z: number, normal: Float64Array): number;
}

/** Tank space: metres, floor centre at the origin, +Y up to the water surface. */
export interface TankDimensions {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export function assertTankDimensions(tank: TankDimensions): void {
  for (const key of ['width', 'height', 'depth'] as const) {
    const v = tank[key];
    if (!Number.isFinite(v) || v <= 0) {
      throw new RangeError(`tank.${key} must be a positive number of metres, got ${v}`);
    }
  }
}

export interface TankSdfOptions {
  /** Leave out the substrate, e.g. for a bottom feeder's steering. */
  readonly floor?: boolean;
  /** Leave out the water surface, e.g. for an air-gulping dart. */
  readonly surface?: boolean;
}

/** Interior of the glass box: floor (substrate top), four panes and the water surface. */
export class TankSdf implements Sdf {
  private readonly hx: number;
  private readonly hz: number;
  private readonly top: number;
  private readonly bottom: number;

  constructor(tank: TankDimensions, options: TankSdfOptions = {}) {
    assertTankDimensions(tank);
    this.hx = tank.width / 2;
    this.hz = tank.depth / 2;
    this.top = options.surface === false ? Infinity : tank.height;
    this.bottom = options.floor === false ? -Infinity : 0;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const cx = clampTo(x, -this.hx, this.hx);
    const cy = clampTo(y, this.bottom, this.top);
    const cz = clampTo(z, -this.hz, this.hz);
    if (cx !== x || cy !== y || cz !== z) {
      // Outside the water (e.g. a look-ahead probe): the exact distance back to the box, so
      // the gradient points diagonally inwards past a corner instead of flipping between panes.
      const ox = cx - x;
      const oy = cy - y;
      const oz = cz - z;
      const len = Math.hypot(ox, oy, oz);
      normal[0] = ox / len;
      normal[1] = oy / len;
      normal[2] = oz / len;
      return -len;
    }
    let d = x + this.hx;
    let nx = 1;
    let ny = 0;
    let nz = 0;
    const right = this.hx - x;
    if (right < d) {
      d = right;
      nx = -1;
    }
    const floor = y - this.bottom;
    if (floor < d) {
      d = floor;
      nx = 0;
      ny = 1;
    }
    const surface = this.top - y;
    if (surface < d) {
      d = surface;
      nx = 0;
      ny = -1;
    }
    const back = z + this.hz;
    if (back < d) {
      d = back;
      nx = 0;
      ny = 0;
      nz = 1;
    }
    const front = this.hz - z;
    if (front < d) {
      d = front;
      nx = 0;
      ny = 0;
      nz = -1;
    }
    normal[0] = nx;
    normal[1] = ny;
    normal[2] = nz;
    return d;
  }
}

/**
 * Central-difference gradient over ±`h`. Unlike the exact gradient it turns smoothly across the
 * medial axis (a corner's diagonal), so steering does not flip between two walls.
 */
export function smoothGradient(
  sdf: Sdf,
  x: number,
  y: number,
  z: number,
  h: number,
  out: Float64Array,
  scratch: Float64Array,
): void {
  const gx = sdf.sample(x + h, y, z, scratch) - sdf.sample(x - h, y, z, scratch);
  const gy = sdf.sample(x, y + h, z, scratch) - sdf.sample(x, y - h, z, scratch);
  const gz = sdf.sample(x, y, z + h, scratch) - sdf.sample(x, y, z - h, scratch);
  const len = Math.hypot(gx, gy, gz);
  if (len > 1e-12) {
    out[0] = gx / len;
    out[1] = gy / len;
    out[2] = gz / len;
  } else {
    sdf.sample(x, y, z, out);
  }
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const MAX_PROJECTIONS = 6;

/**
 * Moves (x, y, z) at `pos[o..o+2]` until it is at least `radius` from every surface. Returns
 * false when that fails, so the caller can fall back to a known-valid position.
 */
export function resolvePenetration(
  sdf: Sdf,
  pos: Float64Array,
  o: number,
  radius: number,
  scratch: Float64Array,
): boolean {
  for (let i = 0; i < MAX_PROJECTIONS; i++) {
    const d = sdf.sample(pos[o] ?? 0, pos[o + 1] ?? 0, pos[o + 2] ?? 0, scratch);
    if (d >= radius) return true;
    const push = radius - d;
    pos[o] = (pos[o] ?? 0) + (scratch[0] ?? 0) * push;
    pos[o + 1] = (pos[o + 1] ?? 0) + (scratch[1] ?? 0) * push;
    pos[o + 2] = (pos[o + 2] ?? 0) + (scratch[2] ?? 0) * push;
  }
  return sdf.sample(pos[o] ?? 0, pos[o + 1] ?? 0, pos[o + 2] ?? 0, scratch) >= radius - 1e-12;
}
