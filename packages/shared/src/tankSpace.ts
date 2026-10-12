import { z } from 'zod';

/**
 * Tank space, the one coordinate frame shared by the sim, the web scene and the server.
 *
 * - Metres, right-handed, +Y up.
 * - Origin: x and z at the centre of the tank footprint, y = 0 at the underside of the bottom
 *   glass. This is the web scene's frame. The sim's old frame (y = 0 at the substrate top) is
 *   converted with `legacyYToTankSpace`.
 * - +X is the tank's width, +Z its depth; the back pane is at -Z, the viewer at +Z.
 * - The water volume is the box inside the glass, pulled in by `inset` so that fish never touch
 *   a pane. Its bottom is the glass top at y = `glass`, its top is `height - freeboard`.
 * - The substrate is a heightfield over the inner footprint. `floor.heights` are absolute
 *   y values (so they already include the glass thickness) at the vertices of an
 *   `nx` by `nz` grid that spans the inner footprint corner to corner, row-major with x
 *   fastest and z from -Z to +Z. `min` and `max` are the extrema of those samples.
 */
export const tankFloorSchema = z.strictObject({
  min: z.number().finite(),
  max: z.number().finite(),
  nx: z.int().min(2).max(512),
  nz: z.int().min(2).max(512),
  heights: z.array(z.number().finite()).max(512 * 512),
});
export type TankFloor = z.infer<typeof tankFloorSchema>;

const FLOOR_TOLERANCE = 1e-9;

export const tankSpaceSchema = z
  .strictObject({
    width: z.number().positive().max(20).describe('outer size along x, metres'),
    depth: z.number().positive().max(20).describe('outer size along z, metres'),
    height: z.number().positive().max(20).describe('outer size along y, metres'),
    glass: z.number().positive().max(0.1).describe('pane thickness, metres'),
    freeboard: z.number().nonnegative().describe('gap from the water surface to the glass rim'),
    inset: z.number().nonnegative().max(0.05).describe('gap kept between water volume and panes'),
    floor: tankFloorSchema,
  })
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (2 * t.glass >= Math.min(t.width, t.depth)) {
      issue(['glass'], 'glass is thicker than the tank allows');
    }
    const waterTop = t.height - t.freeboard;
    if (t.width / 2 - t.glass - t.inset <= 0) {
      issue(['inset'], 'glass and inset leave no water along x');
    }
    if (t.depth / 2 - t.glass - t.inset <= 0) {
      issue(['inset'], 'glass and inset leave no water along z');
    }
    if (waterTop <= t.glass + t.inset) {
      issue(['freeboard'], 'water surface must lie above the bottom glass plus inset');
    }
    const { floor } = t;
    if (floor.heights.length !== floor.nx * floor.nz) {
      issue(['floor', 'heights'], `expected nx * nz = ${floor.nx * floor.nz} samples`);
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of floor.heights) {
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (Math.abs(lo - floor.min) > FLOOR_TOLERANCE) {
      issue(['floor', 'min'], `min must equal the lowest sample, ${lo}`);
    }
    if (Math.abs(hi - floor.max) > FLOOR_TOLERANCE) {
      issue(['floor', 'max'], `max must equal the highest sample, ${hi}`);
    }
    if (lo < t.glass - FLOOR_TOLERANCE) {
      issue(['floor', 'min'], 'substrate cannot lie below the top of the bottom glass');
    }
    if (hi >= waterTop) issue(['floor', 'max'], 'substrate reaches above the water surface');
  });
export type TankSpace = z.infer<typeof tankSpaceSchema>;

export interface TankBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export function tankWaterTop(space: TankSpace): number {
  return space.height - space.freeboard;
}

/** The free-water box: inside the glass, inset from every pane, up to the water surface. */
export function tankWaterBounds(space: TankSpace): TankBounds {
  const hx = space.width / 2 - space.glass - space.inset;
  const hz = space.depth / 2 - space.glass - space.inset;
  return {
    min: [-hx, space.glass + space.inset, -hz],
    max: [hx, tankWaterTop(space), hz],
  };
}

function innerHalf(space: TankSpace): readonly [number, number] {
  return [space.width / 2 - space.glass, space.depth / 2 - space.glass];
}

interface FloorCell {
  readonly i: number;
  readonly j: number;
  readonly fu: number;
  readonly fv: number;
}

function floorCell(space: TankSpace, x: number, z: number): FloorCell {
  const { nx, nz } = space.floor;
  const [hx, hz] = innerHalf(space);
  const u = Math.min(1, Math.max(0, (x + hx) / (2 * hx))) * (nx - 1);
  const v = Math.min(1, Math.max(0, (z + hz) / (2 * hz))) * (nz - 1);
  const i = Math.min(nx - 2, Math.floor(u));
  const j = Math.min(nz - 2, Math.floor(v));
  return { i, j, fu: u - i, fv: v - j };
}

/** Substrate surface height at (x, z), bilinear over the grid and clamped to the footprint. */
export function sampleFloor(space: TankSpace, x: number, z: number): number {
  const { nx, heights } = space.floor;
  const { i, j, fu, fv } = floorCell(space, x, z);
  const at = (a: number, b: number): number => heights[b * nx + a] as number;
  const near = at(i, j) * (1 - fu) + at(i + 1, j) * fu;
  const far = at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu;
  return near * (1 - fv) + far * fv;
}

/** Slope of the substrate, [dh/dx, dh/dz], in the bilinear cell containing (x, z); 0 outside the footprint, where the height is constant. */
export function sampleFloorSlope(space: TankSpace, x: number, z: number): [number, number] {
  const { nx, nz, heights } = space.floor;
  const [hx, hz] = innerHalf(space);
  if (Math.abs(x) > hx || Math.abs(z) > hz) return [0, 0];
  const { i, j, fu, fv } = floorCell(space, x, z);
  const at = (a: number, b: number): number => heights[b * nx + a] as number;
  const cellX = (2 * hx) / (nx - 1);
  const cellZ = (2 * hz) / (nz - 1);
  const dx =
    ((at(i + 1, j) - at(i, j)) * (1 - fv) + (at(i + 1, j + 1) - at(i, j + 1)) * fv) / cellX;
  const dz =
    ((at(i, j + 1) - at(i, j)) * (1 - fu) + (at(i + 1, j + 1) - at(i + 1, j)) * fu) / cellZ;
  return [dx, dz];
}

export interface TankSpaceParams {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly glass: number;
  readonly freeboard: number;
  readonly inset?: number;
  readonly nx?: number;
  readonly nz?: number;
}

/** Samples a height function (absolute y, called with tank-space x and z) into a validated space. */
export function createTankSpace(
  params: TankSpaceParams,
  height: (x: number, z: number) => number,
): TankSpace {
  const nx = params.nx ?? 64;
  const nz = params.nz ?? 32;
  const hx = params.width / 2 - params.glass;
  const hz = params.depth / 2 - params.glass;
  const heights: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < nz; j++) {
    const z = -hz + (2 * hz * j) / (nz - 1);
    for (let i = 0; i < nx; i++) {
      const h = height(-hx + (2 * hx * i) / (nx - 1), z);
      heights.push(h);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  return tankSpaceSchema.parse({
    width: params.width,
    depth: params.depth,
    height: params.height,
    glass: params.glass,
    freeboard: params.freeboard,
    inset: params.inset ?? 0.001,
    floor: { min, max, nx, nz, heights },
  });
}

/**
 * A y in the sim's old frame (0 at the substrate top) as tank space. Only for heights measured
 * from the substrate: the water surface and the glass are not offset by the floor, so never
 * convert them with this.
 */
export function legacyYToTankSpace(space: TankSpace, x: number, z: number, y: number): number {
  return y + sampleFloor(space, x, z);
}

export function tankSpaceYToLegacy(space: TankSpace, x: number, z: number, y: number): number {
  return y - sampleFloor(space, x, z);
}
