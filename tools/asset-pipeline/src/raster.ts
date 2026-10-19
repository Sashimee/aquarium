import sharp from 'sharp';

export interface RasterMesh {
  positions: Float32Array;
  indices: Uint32Array | Uint16Array;
  /** Per-vertex RGB in 0..1. */
  colors?: Float32Array;
  uvs?: Float32Array;
  /** Per-vertex normals; when present they are interpolated for smooth shading instead of flat per-triangle lighting. */
  normals?: Float32Array;
}

export interface TextureImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

export type View = 'side' | 'top' | 'front';

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function boundsOf(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

function projectView(view: View): {
  u: (p: number[]) => number;
  v: (p: number[]) => number;
  depth: (p: number[]) => number;
  light: [number, number, number];
} {
  if (view === 'side') {
    return { u: (p) => p[2]!, v: (p) => p[1]!, depth: (p) => -p[0]!, light: [-0.35, 0.45, 0.82] };
  }
  if (view === 'top') {
    return { u: (p) => p[2]!, v: (p) => p[0]!, depth: (p) => p[1]!, light: [0.3, 0.82, 0.45] };
  }
  return { u: (p) => -p[0]!, v: (p) => p[1]!, depth: (p) => -p[2]!, light: [0.3, 0.45, 0.82] };
}

function sample(image: TextureImage, u: number, v: number): [number, number, number, number] {
  const x = Math.min(image.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * image.height)));
  const i = (y * image.width + x) * image.channels;
  const alpha = image.channels === 4 ? image.data[i + 3]! / 255 : 1;
  return [image.data[i]! / 255, image.data[i + 1]! / 255, image.data[i + 2]! / 255, alpha];
}

/**
 * Orthographic software rasteriser used for the committed fin-mask debug renders and for
 * eyeballing orientation and loft textures; no GPU is needed.
 */
export function rasterise(
  mesh: RasterMesh,
  view: View,
  pixelsAcross: number,
  frame: Bounds,
  texture?: TextureImage,
): { rgb: Uint8Array; width: number; height: number } {
  const proj = projectView(view);
  const corners: number[][] = [];
  for (const x of [frame.min[0], frame.max[0]])
    for (const y of [frame.min[1], frame.max[1]])
      for (const z of [frame.min[2], frame.max[2]]) corners.push([x, y, z]);
  const us = corners.map(proj.u);
  const vs = corners.map(proj.v);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const pad = 0.04 * Math.max(uMax - uMin, vMax - vMin);
  const scale = pixelsAcross / (uMax - uMin + 2 * pad);
  const width = Math.ceil((uMax - uMin + 2 * pad) * scale);
  const height = Math.ceil((vMax - vMin + 2 * pad) * scale);
  const depthBuffer = new Float32Array(width * height).fill(-Infinity);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = 24;
    rgb[i * 3 + 1] = 28;
    rgb[i * 3 + 2] = 34;
  }

  const { positions, indices, colors, uvs, normals } = mesh;
  const light = proj.light;
  const p0 = [0, 0, 0];
  const p1 = [0, 0, 0];
  const p2 = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    for (let k = 0; k < 3; k++) {
      p0[k] = positions[ia * 3 + k]!;
      p1[k] = positions[ib * 3 + k]!;
      p2[k] = positions[ic * 3 + k]!;
    }
    const e1 = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!];
    const e2 = [p2[0]! - p0[0]!, p2[1]! - p0[1]!, p2[2]! - p0[2]!];
    let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    const lambert = Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
    const shade = 0.35 + 0.65 * lambert;

    const sx = [p0, p1, p2].map((p) => (proj.u(p) - uMin + pad) * scale);
    const sy = [p0, p1, p2].map((p) => height - (proj.v(p) - vMin + pad) * scale);
    const sd = [p0, p1, p2].map((p) => proj.depth(p));
    const minX = Math.max(0, Math.floor(Math.min(...sx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...sx)));
    const minY = Math.max(0, Math.floor(Math.min(...sy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...sy)));
    const denom = (sy[1]! - sy[2]!) * (sx[0]! - sx[2]!) + (sx[2]! - sx[1]!) * (sy[0]! - sy[2]!);
    if (Math.abs(denom) < 1e-12) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((sy[1]! - sy[2]!) * (px - sx[2]!) + (sx[2]! - sx[1]!) * (py - sy[2]!)) / denom;
        const w1 = ((sy[2]! - sy[0]!) * (px - sx[2]!) + (sx[0]! - sx[2]!) * (py - sy[2]!)) / denom;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const depth = w0 * sd[0]! + w1 * sd[1]! + w2 * sd[2]!;
        const slot = y * width + x;
        if (depth <= depthBuffer[slot]!) continue;
        let r = 0.7;
        let g = 0.7;
        let b = 0.7;
        let alpha = 1;
        if (texture && uvs && !Number.isNaN(uvs[ia * 2]!)) {
          const u = w0 * uvs[ia * 2]! + w1 * uvs[ib * 2]! + w2 * uvs[ic * 2]!;
          const v = w0 * uvs[ia * 2 + 1]! + w1 * uvs[ib * 2 + 1]! + w2 * uvs[ic * 2 + 1]!;
          [r, g, b, alpha] = sample(texture, u, v);
        } else if (colors) {
          r = w0 * colors[ia * 3]! + w1 * colors[ib * 3]! + w2 * colors[ic * 3]!;
          g = w0 * colors[ia * 3 + 1]! + w1 * colors[ib * 3 + 1]! + w2 * colors[ic * 3 + 1]!;
          b = w0 * colors[ia * 3 + 2]! + w1 * colors[ib * 3 + 2]! + w2 * colors[ic * 3 + 2]!;
        }
        if (alpha < 0.04) continue;
        let pixelShade = shade;
        if (normals) {
          let sx2 = 0;
          let sy2 = 0;
          let sz2 = 0;
          const weights = [w0, w1, w2];
          [ia, ib, ic].forEach((vertex, k) => {
            sx2 += weights[k]! * normals[vertex * 3]!;
            sy2 += weights[k]! * normals[vertex * 3 + 1]!;
            sz2 += weights[k]! * normals[vertex * 3 + 2]!;
          });
          const norm = Math.hypot(sx2, sy2, sz2) || 1;
          const smooth = Math.abs((sx2 * light[0] + sy2 * light[1] + sz2 * light[2]) / norm);
          pixelShade = 0.35 + 0.65 * smooth;
        }
        if (alpha > 0.9) depthBuffer[slot] = depth;
        const keep = alpha > 0.9 ? 0 : 1 - alpha;
        rgb[slot * 3] = Math.min(
          255,
          Math.round(r * pixelShade * 255 * (1 - keep) + rgb[slot * 3]! * keep),
        );
        rgb[slot * 3 + 1] = Math.min(
          255,
          Math.round(g * pixelShade * 255 * (1 - keep) + rgb[slot * 3 + 1]! * keep),
        );
        rgb[slot * 3 + 2] = Math.min(
          255,
          Math.round(b * pixelShade * 255 * (1 - keep) + rgb[slot * 3 + 2]! * keep),
        );
      }
    }
  }
  return { rgb, width, height };
}

export async function renderSheet(
  mesh: RasterMesh,
  views: { view: View; pixelsAcross: number }[],
  texture?: TextureImage,
): Promise<Buffer> {
  const frame = boundsOf(mesh.positions);
  const panels = views.map(({ view, pixelsAcross }) =>
    rasterise(mesh, view, pixelsAcross, frame, texture),
  );
  const height = Math.max(...panels.map((p) => p.height));
  const width = panels.reduce((sum, p) => sum + p.width, 0);
  const sheet = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    sheet[i * 3] = 24;
    sheet[i * 3 + 1] = 28;
    sheet[i * 3 + 2] = 34;
  }
  let offset = 0;
  for (const panel of panels) {
    for (let y = 0; y < panel.height; y++) {
      for (let x = 0; x < panel.width; x++) {
        const src = (y * panel.width + x) * 3;
        const dst = (y * width + offset + x) * 3;
        sheet[dst] = panel.rgb[src]!;
        sheet[dst + 1] = panel.rgb[src + 1]!;
        sheet[dst + 2] = panel.rgb[src + 2]!;
      }
    }
    offset += panel.width;
  }
  return sharp(sheet, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}
