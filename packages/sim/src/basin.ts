import { tankSpaceSchema, tankWaterBounds, type TankSpace } from '@aquarium/shared';

/** The legacy frame: metres, flat floor centre at the origin, +Y up to the water surface. */
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

/**
 * The water a world simulates, in the world's frame: the box between the panes and up to the
 * surface, with the substrate as a heightfield across its bottom.
 *
 * - Built from a `TankSpace`, the frame is tank space itself (y = 0 under the bottom glass) and
 *   `ground` is `sampleFloor`, reimplemented here so the per-step queries allocate nothing.
 * - Built from legacy `TankDimensions`, y = 0 is a flat floor and `ground` is 0 everywhere.
 */
export class Basin {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** The lowest point of the substrate. */
  readonly minY: number;
  /** The highest point of the substrate. */
  readonly floorMax: number;
  /** The water surface. */
  readonly maxY: number;
  readonly space: TankSpace | null;

  private readonly heights: Float64Array;
  private readonly nx: number;
  private readonly nz: number;
  private readonly hx: number;
  private readonly hz: number;
  private readonly cellX: number;
  private readonly cellZ: number;
  private readonly flat: boolean;

  private constructor(
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number },
    floor: { heights: Float64Array; nx: number; nz: number; hx: number; hz: number },
    space: TankSpace | null,
  ) {
    this.minX = bounds.minX;
    this.maxX = bounds.maxX;
    this.minZ = bounds.minZ;
    this.maxZ = bounds.maxZ;
    this.maxY = bounds.maxY;
    this.heights = floor.heights;
    this.nx = floor.nx;
    this.nz = floor.nz;
    this.hx = floor.hx;
    this.hz = floor.hz;
    this.cellX = (2 * floor.hx) / (floor.nx - 1);
    this.cellZ = (2 * floor.hz) / (floor.nz - 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of floor.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    this.minY = lo;
    this.floorMax = hi;
    this.flat = lo === hi;
    this.space = space;
  }

  static fromTank(tank: TankDimensions): Basin {
    assertTankDimensions(tank);
    const hx = tank.width / 2;
    const hz = tank.depth / 2;
    return new Basin(
      { minX: -hx, maxX: hx, minZ: -hz, maxZ: hz, maxY: tank.height },
      { heights: new Float64Array(4), nx: 2, nz: 2, hx, hz },
      null,
    );
  }

  /** Validates `space` (it may come from another thread) and takes its water box and floor. */
  static fromSpace(space: TankSpace): Basin {
    const parsed = tankSpaceSchema.safeParse(space);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      );
      throw new RangeError(`space is not a valid TankSpace: ${issues.join('; ')}`);
    }
    const s = parsed.data;
    const b = tankWaterBounds(s);
    return new Basin(
      { minX: b.min[0], maxX: b.max[0], minZ: b.min[2], maxZ: b.max[2], maxY: b.max[1] },
      {
        heights: Float64Array.from(s.floor.heights),
        nx: s.floor.nx,
        nz: s.floor.nz,
        hx: s.width / 2 - s.glass,
        hz: s.depth / 2 - s.glass,
      },
      s,
    );
  }

  get width(): number {
    return this.maxX - this.minX;
  }

  get depth(): number {
    return this.maxZ - this.minZ;
  }

  /** From the lowest sand to the surface. */
  get height(): number {
    return this.maxY - this.minY;
  }

  /** Substrate height at (x, z): bilinear over the floor grid, clamped to its footprint. */
  ground(x: number, z: number): number {
    return this.sample(x, z, null);
  }

  /** `ground`, also writing the slope [dh/dx, dh/dz] to `slope[0..1]` (as `sampleFloorSlope`). */
  groundWithSlope(x: number, z: number, slope: Float64Array): number {
    return this.sample(x, z, slope);
  }

  // Mirrors `floorCell`, `sampleFloor` and `sampleFloorSlope` in @aquarium/shared operation for
  // operation, so both give bit-identical heights. A level floor, sampled dozens of times per fish
  // each step, skips the bilinear and returns its exact height (the shared one can be an ulp off).
  private sample(x: number, z: number, slope: Float64Array | null): number {
    if (this.flat) {
      if (slope !== null) {
        slope[0] = 0;
        slope[1] = 0;
      }
      return this.minY;
    }
    const nx = this.nx;
    const hx = this.hx;
    const hz = this.hz;
    const u = Math.min(1, Math.max(0, (x + hx) / (2 * hx))) * (nx - 1);
    const v = Math.min(1, Math.max(0, (z + hz) / (2 * hz))) * (this.nz - 1);
    const i = Math.min(nx - 2, Math.floor(u));
    const j = Math.min(this.nz - 2, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const h = this.heights;
    const h00 = h[j * nx + i] ?? 0;
    const h10 = h[j * nx + i + 1] ?? 0;
    const h01 = h[(j + 1) * nx + i] ?? 0;
    const h11 = h[(j + 1) * nx + i + 1] ?? 0;
    if (slope !== null) {
      const dx = ((h10 - h00) * (1 - fv) + (h11 - h01) * fv) / this.cellX;
      const dz = ((h01 - h00) * (1 - fu) + (h11 - h10) * fu) / this.cellZ;
      slope[0] = Math.abs(x) > hx ? 0 : dx;
      slope[1] = Math.abs(z) > hz ? 0 : dz;
    }
    const near = h00 * (1 - fu) + h10 * fu;
    const far = h01 * (1 - fu) + h11 * fu;
    return near * (1 - fv) + far * fv;
  }
}

export function basinOf(tank: Basin | TankDimensions): Basin {
  return tank instanceof Basin ? tank : Basin.fromTank(tank);
}
