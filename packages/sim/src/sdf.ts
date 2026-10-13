import { basinOf, type Basin, type TankDimensions } from './basin.ts';

/**
 * Signed distance to the nearest surface a fish may not cross: positive in free water, negative
 * inside geometry. `sample` writes the unit gradient (pointing into free water) to `normal`.
 */
export interface Sdf {
  sample(x: number, y: number, z: number, normal: Float64Array): number;
}

export { assertTankDimensions, type TankDimensions } from './basin.ts';

export interface TankSdfOptions {
  /** Leave out the substrate, e.g. for a bottom feeder's steering. */
  readonly floor?: boolean;
  /** Leave out the water surface, e.g. for an air-gulping dart. */
  readonly surface?: boolean;
}

/**
 * Interior of the glass box: the substrate heightfield, four panes and the water surface. The
 * distance to the substrate is its height over the local tangent plane, exact on a planar patch
 * and close on the gently curved bilinear cells of a sand slope.
 */
export class TankSdf implements Sdf {
  private readonly basin: Basin;
  private readonly floor: boolean;
  private readonly top: number;
  private readonly slope = new Float64Array(2);

  constructor(tank: Basin | TankDimensions, options: TankSdfOptions = {}) {
    this.basin = basinOf(tank);
    this.floor = options.floor !== false;
    this.top = options.surface === false ? Infinity : this.basin.maxY;
  }

  sample(x: number, y: number, z: number, normal: Float64Array): number {
    const { minX, maxX, minZ, maxZ } = this.basin;
    let floor = Infinity;
    let fx = 0;
    let fy = 1;
    let fz = 0;
    if (this.floor) {
      const g = this.basin.groundWithSlope(x, z, this.slope);
      const sx = this.slope[0] ?? 0;
      const sz = this.slope[1] ?? 0;
      if (sx === 0 && sz === 0) {
        floor = y - g;
      } else {
        const s = Math.sqrt(1 + sx * sx + sz * sz);
        floor = (y - g) / s;
        fx = -sx / s;
        fy = 1 / s;
        fz = -sz / s;
      }
    }
    const ox = x < minX ? minX - x : x > maxX ? maxX - x : 0;
    const oy = y > this.top ? this.top - y : 0;
    const oz = z < minZ ? minZ - z : z > maxZ ? maxZ - z : 0;
    if (ox !== 0 || oy !== 0 || oz !== 0 || floor < 0) {
      // Outside the water (e.g. a look-ahead probe): the distance back to it, so the gradient
      // points diagonally inwards past a corner instead of flipping between panes.
      const under = floor < 0 ? -floor : 0;
      const vx = ox + fx * under;
      const vy = oy + fy * under;
      const vz = oz + fz * under;
      const len = Math.hypot(vx, vy, vz);
      normal[0] = vx / len;
      normal[1] = vy / len;
      normal[2] = vz / len;
      return -len;
    }
    let d = x - minX;
    let nx = 1;
    let ny = 0;
    let nz = 0;
    const right = maxX - x;
    if (right < d) {
      d = right;
      nx = -1;
    }
    if (floor < d) {
      d = floor;
      nx = fx;
      ny = fy;
      nz = fz;
    }
    const surface = this.top - y;
    if (surface < d) {
      d = surface;
      nx = 0;
      ny = -1;
      nz = 0;
    }
    const back = z - minZ;
    if (back < d) {
      d = back;
      nx = 0;
      ny = 0;
      nz = 1;
    }
    const front = maxZ - z;
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
