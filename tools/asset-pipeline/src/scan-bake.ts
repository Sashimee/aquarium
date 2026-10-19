import type { Part } from './parts.ts';
import { fillSmallHoles } from './dense-edit.ts';
import { bakeColour, simplifyDense, unwrapBox, type Dense } from './rebake.ts';
import type { Rgba } from './textures.ts';

export interface ScanBakeOptions {
  targetTriangles: number;
  atlasSize: number;
  /** Empty texels around every chart. */
  gutter: number;
  /** Texels the chart edges are bled outwards after the bake. */
  bleed: number;
  colourWeight?: number;
  /** Boundary loops up to this many vertices that simplification opened in the surface are closed again. */
  closeHolesUpTo?: number;
}

export interface BakedScan {
  part: Part;
  image: Rgba;
  charts: number;
}

/**
 * Turns a dense, coloured, welded scan into a shippable part: simplified first, then unwrapped into a few big
 * charts and painted from the dense colours. Simplifying after the atlas exists tears texture across
 * the fragmented scan charts; this order gives every triangle a UV that fits its surface.
 */
export function bakeScanPart(dense: Dense, material: string, options: ScanBakeOptions): BakedScan {
  const simplified = simplifyDense(dense, {
    targetTriangles: options.targetTriangles,
    ...(options.colourWeight !== undefined ? { colourWeight: options.colourWeight } : {}),
  });
  const closed =
    options.closeHolesUpTo === undefined
      ? simplified
      : fillSmallHoles(simplified, options.closeHolesUpTo);
  const unwrapped = unwrapBox(closed, material, Object.keys(closed.extra).sort(), {
    size: options.atlasSize,
    gutter: options.gutter,
  });
  const image = bakeColour(unwrapped.part, dense, options.atlasSize, options.bleed);
  return { part: unwrapped.part, image, charts: unwrapped.charts };
}
