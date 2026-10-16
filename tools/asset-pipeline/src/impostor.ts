import type { Document, Material, Primitive } from '@gltf-transform/core';
import sharp from 'sharp';
import { FIN_ID_ATTRIBUTE, FIN_MASK_ATTRIBUTE, type OutputAsset } from './index-schema.ts';
import {
  cellDirection,
  decodeViewNormal,
  encodeViewNormal,
  viewBasis,
  type Vec3,
} from './octahedral.ts';
import { encodeKtx2, resizeImage, type Rgba } from './textures.ts';

export const IMPOSTOR_SOURCE_LOD = 1;
export const IMPOSTOR_GRID = 9;
export const IMPOSTOR_FRAME_SIZE = 128;
const SUPERSAMPLE = 4;
const BLEED_PASSES = 4;
const TEXTURE_MAX_DIM = 512;
const BLEND_CUTOFF = 0.15;
export const IMPOSTOR_MAX_MIP_LEVEL = 3;
const RADIUS_MARGIN = 1.07;
const BACKGROUND = 30;

export interface BakeMaterial {
  baseColorFactor: [number, number, number, number];
  baseColor?: Rgba;
  alphaCutoff: number;
}

export interface BakeMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array | Uint16Array;
  /** Fin mask on fin vertices, 0 on the rigid body. */
  finMask: Float32Array;
  material: BakeMaterial;
}

export interface Atlas {
  grid: number;
  frameSize: number;
  pivot: Vec3;
  radius: number;
  albedo: Rgba;
  normalDepth: Rgba;
}

export type ImpostorInfo = NonNullable<OutputAsset['impostor']>;

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

function arraysOf(prim: Primitive): Omit<BakeMesh, 'material'> {
  const need = (name: string) => {
    const accessor = prim.getAttribute(name);
    if (!accessor) throw new Error(`impostor: primitive lacks ${name}`);
    return accessor.getArray()!;
  };
  const indices = prim.getIndices()?.getArray();
  if (!indices) throw new Error('impostor: primitive is not indexed');
  const rawMask = need(FIN_MASK_ATTRIBUTE);
  const finId = need(FIN_ID_ATTRIBUTE);
  const finMask = new Float32Array(rawMask.length);
  for (let k = 0; k < finMask.length; k++) finMask[k] = finId[k]! > 0 ? rawMask[k]! : 0;
  return {
    positions: need('POSITION') as Float32Array,
    normals: need('NORMAL') as Float32Array,
    uvs: (prim.getAttribute('TEXCOORD_0')?.getArray() ?? new Float32Array(0)) as Float32Array,
    indices: indices as Uint32Array | Uint16Array,
    finMask,
  };
}

function alphaCutoffOf(material: Material | null): number {
  if (material?.getAlphaMode() === 'MASK') return material.getAlphaCutoff();
  return material?.getAlphaMode() === 'BLEND' ? BLEND_CUTOFF : 0.5;
}

export async function meshesFromDocument(
  doc: Document,
  images: ReadonlyMap<string, Rgba>,
): Promise<BakeMesh[]> {
  const resized = new Map<string, Rgba>();
  const out: BakeMesh[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const material = prim.getMaterial();
      const textureName = material?.getBaseColorTexture()?.getName();
      let baseColor: Rgba | undefined;
      if (textureName !== undefined) {
        const source = images.get(textureName);
        if (!source) throw new Error(`impostor: no source image for texture "${textureName}"`);
        if (!resized.has(textureName))
          resized.set(textureName, await resizeImage(source, TEXTURE_MAX_DIM));
        baseColor = resized.get(textureName);
      }
      out.push({
        ...arraysOf(prim),
        material: {
          baseColorFactor: (material?.getBaseColorFactor() ?? [1, 1, 1, 1]) as [
            number,
            number,
            number,
            number,
          ],
          ...(baseColor ? { baseColor } : {}),
          alphaCutoff: alphaCutoffOf(material),
        },
      });
    }
  }
  return out;
}

/**
 * Sphere around the bounding-box centre that contains every vertex. The margin leaves a rim of about
 * half a texel of the coarsest sampled mip level (`IMPOSTOR_MAX_MIP_LEVEL`) empty, which is where the
 * shader clamps its UVs.
 */
export function boundingSphere(meshes: BakeMesh[]): { pivot: Vec3; radius: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of meshes)
    for (let i = 0; i < positions.length; i += 3)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, positions[i + a]!);
        max[a] = Math.max(max[a]!, positions[i + a]!);
      }
  const pivot = min.map((lo, a) => round6((lo + max[a]!) / 2)) as Vec3;
  let farthest = 0;
  for (const { positions } of meshes)
    for (let i = 0; i < positions.length; i += 3)
      farthest = Math.max(
        farthest,
        Math.hypot(
          positions[i]! - pivot[0],
          positions[i + 1]! - pivot[1],
          positions[i + 2]! - pivot[2],
        ),
      );
  return { pivot, radius: Math.ceil(farthest * RADIUS_MARGIN * 1e6) / 1e6 };
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, b) => {
  const v = b / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** Bilinear tap of an sRGB image; the colour channels come out linear, alpha unchanged. */
function sampleBilinear(image: Rgba, u: number, v: number, out: number[]): void {
  const x = (u - Math.floor(u)) * image.width - 0.5;
  const y = (v - Math.floor(v)) * image.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out.fill(0);
  for (let k = 0; k < 4; k++) {
    const sx = (((x0 + (k & 1)) % image.width) + image.width) % image.width;
    const sy = (((y0 + (k >> 1)) % image.height) + image.height) % image.height;
    const weight = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
    const at = (sy * image.width + sx) * 4;
    for (let c = 0; c < 4; c++)
      out[c]! +=
        weight * (c < 3 ? SRGB_TO_LINEAR[image.data[at + c]!]! : image.data[at + c]! / 255);
  }
}

interface Samples {
  size: number;
  depth: Float32Array;
  colour: Float32Array;
  normal: Float32Array;
  fin: Float32Array;
}

function renderView(
  meshes: BakeMesh[],
  d: Vec3,
  pivot: Vec3,
  radius: number,
  size: number,
): Samples {
  const { right, up } = viewBasis(d);
  const samples: Samples = {
    size,
    depth: new Float32Array(size * size).fill(-Infinity),
    colour: new Float32Array(size * size * 3),
    normal: new Float32Array(size * size * 3),
    fin: new Float32Array(size * size),
  };
  const half = size / 2;
  const texel = [0, 0, 0, 0];
  for (const mesh of meshes) {
    const vertexCount = mesh.positions.length / 3;
    const sx = new Float32Array(vertexCount);
    const sy = new Float32Array(vertexCount);
    const sz = new Float32Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const px = mesh.positions[v * 3]! - pivot[0];
      const py = mesh.positions[v * 3 + 1]! - pivot[1];
      const pz = mesh.positions[v * 3 + 2]! - pivot[2];
      sx[v] = (1 + (px * right[0] + py * right[1] + pz * right[2]) / radius) * half;
      sy[v] = (1 - (px * up[0] + py * up[1] + pz * up[2]) / radius) * half;
      sz[v] = (px * d[0] + py * d[1] + pz * d[2]) / radius;
    }
    const { baseColorFactor: factor, baseColor, alphaCutoff } = mesh.material;
    const { uvs, normals, finMask } = mesh;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!;
      const b = mesh.indices[t + 1]!;
      const c = mesh.indices[t + 2]!;
      const denom = (sy[b]! - sy[c]!) * (sx[a]! - sx[c]!) + (sx[c]! - sx[b]!) * (sy[a]! - sy[c]!);
      if (Math.abs(denom) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(sx[a]!, sx[b]!, sx[c]!)));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(sx[a]!, sx[b]!, sx[c]!)));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a]!, sy[b]!, sy[c]!)));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(sy[a]!, sy[b]!, sy[c]!)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 =
            ((sy[b]! - sy[c]!) * (px - sx[c]!) + (sx[c]! - sx[b]!) * (py - sy[c]!)) / denom;
          const w1 =
            ((sy[c]! - sy[a]!) * (px - sx[c]!) + (sx[a]! - sx[c]!) * (py - sy[c]!)) / denom;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const depth = w0 * sz[a]! + w1 * sz[b]! + w2 * sz[c]!;
          const slot = y * size + x;
          if (depth <= samples.depth[slot]!) continue;
          let alpha = factor[3];
          let colour: Vec3 = [factor[0], factor[1], factor[2]];
          if (baseColor) {
            sampleBilinear(
              baseColor,
              w0 * uvs[a * 2]! + w1 * uvs[b * 2]! + w2 * uvs[c * 2]!,
              w0 * uvs[a * 2 + 1]! + w1 * uvs[b * 2 + 1]! + w2 * uvs[c * 2 + 1]!,
              texel,
            );
            colour = [colour[0] * texel[0]!, colour[1] * texel[1]!, colour[2] * texel[2]!];
            alpha *= texel[3]!;
          }
          if (alpha < alphaCutoff) continue;
          const n = [0, 1, 2].map(
            (k) => w0 * normals[a * 3 + k]! + w1 * normals[b * 3 + k]! + w2 * normals[c * 3 + k]!,
          ) as Vec3;
          const length = Math.hypot(n[0], n[1], n[2]) || 1;
          const facing = (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0 ? -1 : 1) / length;
          samples.depth[slot] = depth;
          for (let k = 0; k < 3; k++) {
            samples.colour[slot * 3 + k] = colour[k]!;
            samples.normal[slot * 3 + k] = n[k]! * facing;
          }
          samples.fin[slot] = w0 * finMask[a]! + w1 * finMask[b]! + w2 * finMask[c]!;
        }
      }
    }
  }
  return samples;
}

const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

interface Frame {
  size: number;
  coverage: Float32Array;
  known: Uint8Array;
  rgb: Float32Array;
  normal: Float32Array;
  fin: Float32Array;
  depth: Float32Array;
}

function resolveFrame(samples: Samples, size: number): Frame {
  const ss = samples.size / size;
  const frame: Frame = {
    size,
    coverage: new Float32Array(size * size),
    known: new Uint8Array(size * size),
    rgb: new Float32Array(size * size * 3),
    normal: new Float32Array(size * size * 3),
    fin: new Float32Array(size * size),
    depth: new Float32Array(size * size),
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const out = y * size + x;
      let hits = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const slot = (y * ss + sy) * samples.size + x * ss + sx;
          if (samples.depth[slot] === -Infinity) continue;
          hits++;
          for (let k = 0; k < 3; k++) {
            frame.rgb[out * 3 + k]! += samples.colour[slot * 3 + k]!;
            frame.normal[out * 3 + k]! += samples.normal[slot * 3 + k]!;
          }
          frame.fin[out]! += samples.fin[slot]!;
          frame.depth[out]! += samples.depth[slot]!;
        }
      frame.coverage[out] = hits / (ss * ss);
      if (hits === 0) continue;
      frame.known[out] = 1;
      for (let k = 0; k < 3; k++) {
        frame.rgb[out * 3 + k]! /= hits;
        frame.normal[out * 3 + k]! /= hits;
      }
      frame.fin[out]! /= hits;
      frame.depth[out]! /= hits;
    }
  return frame;
}

/** Spreads covered texels outwards so bilinear filtering and mips at the silhouette do not pull in black. */
function bleed(frame: Frame): void {
  const { size } = frame;
  let known = Uint8Array.from(frame.known);
  for (let pass = 0; pass < BLEED_PASSES; pass++) {
    const next = Uint8Array.from(known);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const at = y * size + x;
        if (known[at]) continue;
        let n = 0;
        const sum = [0, 0, 0, 0, 0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const from = ny * size + nx;
            if (!known[from]) continue;
            n++;
            for (let k = 0; k < 3; k++) {
              sum[k]! += frame.rgb[from * 3 + k]!;
              sum[3 + k]! += frame.normal[from * 3 + k]!;
            }
            sum[6]! += frame.fin[from]!;
            sum[7]! += frame.depth[from]!;
          }
        if (n === 0) continue;
        for (let k = 0; k < 3; k++) {
          frame.rgb[at * 3 + k] = sum[k]! / n;
          frame.normal[at * 3 + k] = sum[3 + k]! / n;
        }
        frame.fin[at] = sum[6]! / n;
        frame.depth[at] = sum[7]! / n;
        next[at] = 1;
      }
    known = next;
  }
  frame.known = known;
}

function averageColour(frame: Frame): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  let n = 0;
  for (let p = 0; p < frame.known.length; p++) {
    if (!frame.known[p]) continue;
    n++;
    for (let k = 0; k < 3; k++) sum[k]! += frame.rgb[p * 3 + k]!;
  }
  return n === 0 ? sum : [sum[0] / n, sum[1] / n, sum[2] / n];
}

export function bakeAtlas(
  meshes: BakeMesh[],
  grid = IMPOSTOR_GRID,
  frameSize = IMPOSTOR_FRAME_SIZE,
): Atlas {
  const { pivot, radius } = boundingSphere(meshes);
  const size = grid * frameSize;
  const albedo: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const normalDepth: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let j = 0; j < grid; j++)
    for (let i = 0; i < grid; i++) {
      const d = cellDirection(i, j, grid);
      const basis = viewBasis(d);
      const frame = resolveFrame(
        renderView(meshes, d, pivot, radius, frameSize * SUPERSAMPLE),
        frameSize,
      );
      const fill = averageColour(frame);
      bleed(frame);
      for (let y = 0; y < frameSize; y++)
        for (let x = 0; x < frameSize; x++) {
          const local = y * frameSize + x;
          const at = ((j * frameSize + y) * size + i * frameSize + x) * 4;
          const known = frame.known[local] === 1;
          for (let k = 0; k < 3; k++)
            albedo.data[at + k] = byte(toSrgb(known ? frame.rgb[local * 3 + k]! : fill[k]!));
          albedo.data[at + 3] = byte(frame.coverage[local]!);
          const n: Vec3 = known
            ? [frame.normal[local * 3]!, frame.normal[local * 3 + 1]!, frame.normal[local * 3 + 2]!]
            : d;
          const length = Math.hypot(n[0], n[1], n[2]) || 1;
          const [u, v] = encodeViewNormal([n[0] / length, n[1] / length, n[2] / length], basis);
          normalDepth.data[at] = byte(u);
          normalDepth.data[at + 1] = byte(v);
          normalDepth.data[at + 2] = known ? byte(frame.fin[local]!) : 0;
          normalDepth.data[at + 3] = known ? byte(0.5 + 0.5 * frame.depth[local]!) : 128;
        }
    }
  return { grid, frameSize, pivot, radius, albedo, normalDepth };
}

export interface EncodedAtlas {
  albedo: Uint8Array;
  normalDepth: Uint8Array;
}

export async function encodeAtlas(atlas: Atlas): Promise<EncodedAtlas> {
  return {
    albedo: await encodeKtx2(atlas.albedo, {
      codec: 'etc1s',
      colorSpace: 'srgb',
      role: 'baseColor',
    }),
    normalDepth: await encodeKtx2(atlas.normalDepth, {
      codec: 'uastc',
      colorSpace: 'linear',
      role: 'emissive',
    }),
  };
}

/** Per species: albedo over a dark ground, then the decoded normals (rgb) over the same ground. */
export async function contactSheet(atlases: Atlas[]): Promise<Buffer> {
  const panelSize = 512;
  const panels = await Promise.all(
    atlases.flatMap((atlas) => {
      const { width, height } = atlas.albedo;
      const bases = Array.from({ length: atlas.grid * atlas.grid }, (_, f) =>
        viewBasis(cellDirection(f % atlas.grid, Math.floor(f / atlas.grid), atlas.grid)),
      );
      const colour = Buffer.alloc(width * height * 3);
      const normal = Buffer.alloc(width * height * 3);
      for (let p = 0; p < width * height; p++) {
        const a = atlas.albedo.data[p * 4 + 3]! / 255;
        const frameAt =
          Math.floor(((p / width) | 0) / atlas.frameSize) * atlas.grid +
          Math.floor((p % width) / atlas.frameSize);
        const n = decodeViewNormal(
          atlas.normalDepth.data[p * 4]! / 255,
          atlas.normalDepth.data[p * 4 + 1]! / 255,
          bases[frameAt]!,
        );
        for (let k = 0; k < 3; k++) {
          colour[p * 3 + k] = Math.round(atlas.albedo.data[p * 4 + k]! * a + BACKGROUND * (1 - a));
          normal[p * 3 + k] = Math.round((n[k]! * 0.5 + 0.5) * 255 * a + BACKGROUND * (1 - a));
        }
      }
      return [colour, normal].map((raw) =>
        sharp(raw, { raw: { width, height, channels: 3 } })
          .resize(panelSize, panelSize)
          .raw()
          .toBuffer(),
      );
    }),
  );
  const sheet = Buffer.alloc(2 * panelSize * atlases.length * panelSize * 3, BACKGROUND);
  panels.forEach((panel, n) => {
    const column = n % 2;
    const row = Math.floor(n / 2);
    for (let y = 0; y < panelSize; y++)
      panel.copy(
        sheet,
        ((row * panelSize + y) * 2 * panelSize + column * panelSize) * 3,
        y * panelSize * 3,
        (y + 1) * panelSize * 3,
      );
  });
  return sharp(sheet, {
    raw: { width: 2 * panelSize, height: atlases.length * panelSize, channels: 3 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
