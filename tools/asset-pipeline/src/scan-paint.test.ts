import { describe, expect, it } from 'vitest';
import { FIN_ID_ATTRIBUTE, FIN_IDS, FIN_MASK_ATTRIBUTE } from './index-schema.ts';
import type { MaterialDef, Part } from './parts.ts';
import {
  dilateLayer,
  paintBlackPhantom,
  paintScanTexture,
  projectSideUv,
  rasteriseFinLayer,
  sideProjection,
} from './scan-paint.ts';

/** Body quad in the YZ plane (z 0..1 forward, y 0..0.4) with a dorsal triangle rising above it. */
function fish(): Part {
  const positions = [0, 0, 0, 0, 0, 1, 0, 0.4, 1, 0, 0.4, 0, 0, 0.4, 0.2, 0, 0.4, 0.6, 0, 0.8, 0.4];
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length).fill(0),
    uvs: new Float32Array(14),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
    material: 'm',
    extra: {
      [FIN_ID_ATTRIBUTE]: new Float32Array([
        0,
        0,
        0,
        0,
        FIN_IDS.dorsal,
        FIN_IDS.dorsal,
        FIN_IDS.dorsal,
      ]),
      [FIN_MASK_ATTRIBUTE]: new Float32Array([0, 0, 0, 0, 0, 0, 1]),
    },
  };
}

const base: MaterialDef = {
  name: 'm',
  baseColorFactor: [0.1, 0.1, 0.1, 1],
  roughness: 0.6,
  metallic: 0,
  alphaMode: 'OPAQUE',
  doubleSided: true,
  normalScale: 1,
};

describe('sideProjection', () => {
  it('frames the body on its rigid vertices and the texture on everything', () => {
    const frame = sideProjection([fish()]);
    expect(frame.bodyLength).toBeCloseTo(1);
    expect(frame.bodyHeight).toBeCloseTo(0.4);
    expect(frame.bodyBottomY).toBeCloseTo(0);
    expect(frame.topY).toBeCloseTo(0.8);
    expect(frame.snoutZ).toBeCloseTo(1);
    expect(frame.tailZ).toBeCloseTo(0);
  });

  it('measures tn from the rigid snout even when a fin reaches past it', () => {
    const part = fish();
    part.positions[17] = 1.3;
    const frame = sideProjection([part]);
    expect(frame.snoutZ).toBeCloseTo(1.3);
    expect(frame.bodySnoutZ).toBeCloseTo(1);
  });

  it('refuses a mesh whose fin attributes are not baked yet', () => {
    const part = fish();
    part.extra = { [FIN_MASK_ATTRIBUTE]: part.extra[FIN_MASK_ATTRIBUTE]! };
    expect(() => sideProjection([part])).toThrow(/fin id and fin mask/);
  });

  it('puts the snout at u 0, the tail at u 1, the highest vertex at v 0 and the belly at v 1', () => {
    const part = fish();
    projectSideUv([part], sideProjection([part]));
    expect([part.uvs[0], part.uvs[1]]).toEqual([1, 1]);
    expect(part.uvs[2]).toBeCloseTo(0);
    expect(part.uvs[1 * 2 + 1]).toBeCloseTo(1);
    expect(part.uvs[6 * 2 + 1]).toBeCloseTo(0);
  });
});

describe('rasteriseFinLayer', () => {
  it('marks body texels 0, fin texels with the fin id and the rest -1', () => {
    const part = fish();
    projectSideUv([part], sideProjection([part]));
    const layer = rasteriseFinLayer([part], 64, 64);
    expect(layer[48 * 64 + 32]).toBe(0);
    expect(layer[8 * 64 + 40]).toBe(FIN_IDS.dorsal);
    expect(layer[2 * 64 + 2]).toBe(-1);
  });

  it('draws a fin over the body where their projections overlap', () => {
    const part = fish();
    part.positions[4 * 3 + 1] = 0.2;
    part.positions[5 * 3 + 1] = 0.2;
    projectSideUv([part], sideProjection([part]));
    const layer = rasteriseFinLayer([part], 64, 64);
    const fins = layer.filter((v) => v === FIN_IDS.dorsal).length;
    expect(fins).toBeGreaterThan(0);
  });

  it('treats a triangle with a single fin vertex as body', () => {
    const part = fish();
    part.extra[FIN_ID_ATTRIBUTE]![5] = 0;
    part.extra[FIN_ID_ATTRIBUTE]![4] = 0;
    projectSideUv([part], sideProjection([part]));
    const layer = rasteriseFinLayer([part], 64, 64);
    expect(layer.includes(FIN_IDS.dorsal)).toBe(false);
  });
});

describe('dilateLayer', () => {
  it('grows covered texels into empty neighbours without overwriting them', () => {
    const layer = new Int8Array(25).fill(-1);
    layer[12] = 3;
    layer[13] = 0;
    const out = dilateLayer(layer, 5, 5, 1);
    expect(out[11]).toBe(3);
    expect(out[7]).toBe(3);
    expect(out[12]).toBe(3);
    expect(out[13]).toBe(0);
    expect(out[0]).toBe(-1);
  });
});

describe('paintScanTexture', () => {
  it('paints a coloured texture, points every part at the new material and sets the UVs', () => {
    const part = fish();
    const painted = paintScanTexture([part], base, {
      paint: (_tn, _h, fin) => (fin === 0 ? [1, 0, 0] : [0, 0, 1]),
      width: 64,
      height: 64,
      roughness: 0.3,
    });
    const image = painted.baseColor!.image;
    expect(painted.roughness).toBe(0.3);
    expect(painted.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(part.uvs[0]).toBeCloseTo(1);
    const at = (x: number, y: number) => [
      ...image.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3),
    ];
    expect(at(32, 48)).toEqual([255, 0, 0]);
    expect(at(40, 8)).toEqual([0, 0, 255]);
  });
});

describe('paintBlackPhantom', () => {
  const luminance = (c: [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  it('puts a black humeral blotch behind a paler bar', () => {
    expect(luminance(paintBlackPhantom(0.3, 0.46, 0))).toBeLessThan(0.05);
    expect(luminance(paintBlackPhantom(0.2, 0.5, 0))).toBeGreaterThan(0.6);
    expect(luminance(paintBlackPhantom(0.5, 0.5, 0))).toBeGreaterThan(0.3);
  });

  it('keeps the blotch off the back so a side projection does not wrap it over the top', () => {
    expect(luminance(paintBlackPhantom(0.3, 0.8, 0))).toBeGreaterThan(0.1);
    expect(luminance(paintBlackPhantom(0.3, 0.95, 0))).toBeGreaterThan(0.1);
  });

  it('shades the back darker than the belly', () => {
    expect(luminance(paintBlackPhantom(0.55, 0.95, 0))).toBeLessThan(
      luminance(paintBlackPhantom(0.55, 0.05, 0)),
    );
  });

  it('gives the dorsal fin black and the pelvic fin a red cast', () => {
    expect(luminance(paintBlackPhantom(0.5, 1.4, FIN_IDS.dorsal))).toBeLessThan(0.15);
    const [r, g, b] = paintBlackPhantom(0.5, -0.2, FIN_IDS.pelvic);
    expect(r).toBeGreaterThan(g + 0.2);
    expect(r).toBeGreaterThan(b + 0.2);
  });
});
