import { Document, type Material } from '@gltf-transform/core';
import {
  KHRMaterialsPBRSpecularGlossiness,
  type PBRSpecularGlossiness,
} from '@gltf-transform/extensions';
import {
  decodeImage,
  hasMeaningfulAlpha,
  type Rgba,
  type TextureCodec,
  type TextureRole,
} from './textures.ts';

export interface Part {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  uvs: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  material: string;
  extra: Record<string, Float32Array<ArrayBuffer>>;
}

export type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

export interface TextureSource {
  role: TextureRole;
  codec: TextureCodec;
  image: Rgba;
}

export interface MaterialDef {
  name: string;
  baseColorFactor: [number, number, number, number];
  baseColor?: TextureSource;
  normal?: TextureSource;
  metallicRoughness?: TextureSource;
  roughness: number;
  metallic: number;
  alphaMode: AlphaMode;
  doubleSided: boolean;
  normalScale: number;
}

export function extractParts(doc: Document): Part[] {
  const parts: Part[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      const count = position.getCount();
      const normal = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      const uvs = new Float32Array(count * 2);
      const e: number[] = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        position.getElement(i, e);
        positions.set(e, i * 3);
        if (normal) {
          normal.getElement(i, e);
          normals.set(e, i * 3);
        }
        if (uv) {
          uv.getElement(i, e);
          uvs[i * 2] = e[0]!;
          uvs[i * 2 + 1] = e[1]!;
        }
      }
      const indexAccessor = prim.getIndices();
      const indices = indexAccessor
        ? Uint32Array.from(indexAccessor.getArray()!)
        : Uint32Array.from({ length: count }, (_, i) => i);
      parts.push({
        positions,
        normals,
        uvs,
        indices,
        material: prim.getMaterial()?.getName() ?? '',
        extra: {},
      });
    }
  }
  return parts;
}

export function mergeParts(parts: Part[], material: string): Part {
  const extraKeys = new Set(parts.flatMap((p) => Object.keys(p.extra)));
  const vertexTotal = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const indexTotal = parts.reduce((s, p) => s + p.indices.length, 0);
  const merged: Part = {
    positions: new Float32Array(vertexTotal * 3),
    normals: new Float32Array(vertexTotal * 3),
    uvs: new Float32Array(vertexTotal * 2),
    indices: new Uint32Array(indexTotal),
    material,
    extra: Object.fromEntries([...extraKeys].map((k) => [k, new Float32Array(vertexTotal)])),
  };
  let v = 0;
  let i = 0;
  for (const part of parts) {
    const count = part.positions.length / 3;
    merged.positions.set(part.positions, v * 3);
    merged.normals.set(part.normals, v * 3);
    merged.uvs.set(part.uvs, v * 2);
    for (const key of extraKeys)
      merged.extra[key]!.set(part.extra[key] ?? new Float32Array(count), v);
    for (const index of part.indices) merged.indices[i++] = index + v;
    v += count;
  }
  return merged;
}

/** Collapses vertices that share position, normal and uv so simplification can see connectivity. */
export function weldPart(part: Part): Part {
  const count = part.positions.length / 3;
  const extraKeys = Object.keys(part.extra).sort();
  const seen = new Map<string, number>();
  const remap = new Uint32Array(count);
  const kept: number[] = [];
  const q = (x: number): number => Math.round(x * 1e5);
  for (let i = 0; i < count; i++) {
    const key = [
      q(part.positions[i * 3]!),
      q(part.positions[i * 3 + 1]!),
      q(part.positions[i * 3 + 2]!),
      q(part.normals[i * 3]!),
      q(part.normals[i * 3 + 1]!),
      q(part.normals[i * 3 + 2]!),
      q(part.uvs[i * 2]!),
      q(part.uvs[i * 2 + 1]!),
      ...extraKeys.map((k) => q(part.extra[k]![i]!)),
    ].join(',');
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, kept.length);
      remap[i] = kept.length;
      kept.push(i);
    } else {
      remap[i] = existing;
    }
  }
  const out: Part = {
    positions: new Float32Array(kept.length * 3),
    normals: new Float32Array(kept.length * 3),
    uvs: new Float32Array(kept.length * 2),
    indices: new Uint32Array(part.indices.length),
    material: part.material,
    extra: Object.fromEntries(extraKeys.map((k) => [k, new Float32Array(kept.length)])),
  };
  kept.forEach((src, dst) => {
    out.positions.set(part.positions.subarray(src * 3, src * 3 + 3), dst * 3);
    out.normals.set(part.normals.subarray(src * 3, src * 3 + 3), dst * 3);
    out.uvs.set(part.uvs.subarray(src * 2, src * 2 + 2), dst * 2);
    for (const k of extraKeys) out.extra[k]![dst] = part.extra[k]![src]!;
  });
  let w = 0;
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = remap[part.indices[t]!]!;
    const b = remap[part.indices[t + 1]!]!;
    const c = remap[part.indices[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    out.indices[w++] = a;
    out.indices[w++] = b;
    out.indices[w++] = c;
  }
  return { ...out, indices: out.indices.slice(0, w) };
}

export function opaqueCopy(image: Rgba): Rgba {
  const data = new Uint8Array(image.data);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { ...image, data };
}

async function textureFrom(
  texture: { getImage(): Uint8Array | null } | null,
  role: TextureRole,
  codec: TextureCodec,
): Promise<TextureSource | undefined> {
  const bytes = texture?.getImage();
  if (!bytes) return undefined;
  return { role, codec, image: await decodeImage(bytes) };
}

export interface MaterialOptions {
  roughness?: number;
  metallic?: number;
  keepNormal?: boolean;
  /** Force alpha handling; otherwise a BLEND/MASK source keeps it only when the colour texture really has transparency. */
  alphaMode?: AlphaMode;
  doubleSided?: boolean;
}

export async function materialDefFrom(
  source: Material,
  options: MaterialOptions = {},
): Promise<MaterialDef> {
  const specGloss = source.getExtension<PBRSpecularGlossiness>(
    KHRMaterialsPBRSpecularGlossiness.EXTENSION_NAME,
  );
  const baseColor = await textureFrom(
    specGloss ? specGloss.getDiffuseTexture() : source.getBaseColorTexture(),
    'baseColor',
    'etc1s',
  );
  const normal =
    options.keepNormal === false
      ? undefined
      : await textureFrom(source.getNormalTexture(), 'normal', 'uastc');
  const factor = specGloss ? specGloss.getDiffuseFactor() : source.getBaseColorFactor();
  let alphaMode: AlphaMode = options.alphaMode ?? 'OPAQUE';
  if (options.alphaMode === undefined && source.getAlphaMode() !== 'OPAQUE') {
    const textureAlpha = baseColor ? hasMeaningfulAlpha(baseColor.image) : false;
    const factorAlpha = !baseColor && factor[3] < 0.99;
    if (textureAlpha || factorAlpha) alphaMode = source.getAlphaMode();
  }
  const finalBase =
    baseColor && alphaMode === 'OPAQUE'
      ? { ...baseColor, image: opaqueCopy(baseColor.image) }
      : baseColor;
  return {
    name: source.getName() || 'material',
    baseColorFactor: [factor[0], factor[1], factor[2], alphaMode === 'OPAQUE' ? 1 : factor[3]],
    ...(finalBase ? { baseColor: finalBase } : {}),
    ...(normal ? { normal } : {}),
    roughness:
      options.roughness ??
      Math.min(
        1,
        Math.max(
          0.2,
          specGloss ? 1 - specGloss.getGlossinessFactor() : source.getRoughnessFactor(),
        ),
      ),
    metallic: options.metallic ?? 0,
    alphaMode,
    doubleSided: options.doubleSided ?? source.getDoubleSided(),
    normalScale: source.getNormalScale(),
  };
}
