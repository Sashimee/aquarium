import {
  Accessor,
  Document,
  Logger,
  type Material,
  type Primitive,
  type Texture,
} from '@gltf-transform/core';
import { cloneDocument, prune } from '@gltf-transform/functions';
import {
  bindKtx2Textures,
  variantFileName,
  writeFileTracked,
  writeGlb,
  type WrittenFile,
} from './glb.ts';
import { LOD_COUNT, type AssetKind, type OutputAsset } from './index-schema.ts';
import { simplifyPrimitive, triangleCountOf } from './lod.ts';
import type { MaterialDef, Part, TextureSource } from './parts.ts';
import { encodeTiers, type EncodedVariant, type TextureCodec, type Tier } from './textures.ts';

export interface LodPlan {
  /** Triangle ratios for LOD0..LOD2 against the welded input. */
  ratios: [number, number, number];
  minTriangles: number;
  /** Runs on each primitive of LOD `level` before simplification. */
  prepare?: (prim: Primitive, level: number) => void;
}

export interface TextureEntry {
  name: string;
  source: TextureSource;
  colorSpace: 'srgb' | 'linear';
  variants?: Record<Tier, EncodedVariant>;
}

export interface BuiltDocument {
  doc: Document;
  textures: TextureEntry[];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function accessorFor(
  doc: Document,
  array: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>,
  type: 'SCALAR' | 'VEC2' | 'VEC3',
): Accessor {
  return doc
    .createAccessor()
    .setType(type)
    .setArray(array)
    .setBuffer(doc.getRoot().listBuffers()[0]!);
}

export function buildDocument(
  assetId: string,
  parts: Part[],
  materialDefs: MaterialDef[],
): BuiltDocument {
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
  const buffer = doc.createBuffer();
  doc.getRoot().getAsset().generator = 'aquarium-asset-pipeline';
  const textures: TextureEntry[] = [];
  const materials = new Map<string, Material>();

  for (const def of materialDefs) {
    const material = doc
      .createMaterial(def.name)
      .setBaseColorFactor(def.baseColorFactor)
      .setRoughnessFactor(def.roughness)
      .setMetallicFactor(def.metallic)
      .setAlphaMode(def.alphaMode)
      .setDoubleSided(def.doubleSided);
    if (def.alphaMode === 'MASK') material.setAlphaCutoff(0.5);
    const prefix = materialDefs.length > 1 ? `${assetId}_${slug(def.name)}` : assetId;
    const addTexture = (suffix: string, source: TextureSource | undefined): Texture | null => {
      if (!source) return null;
      const name = `${prefix}_${suffix}`;
      textures.push({ name, source, colorSpace: source.role === 'baseColor' ? 'srgb' : 'linear' });
      return doc.createTexture(name);
    };
    const base = addTexture('basecolor', def.baseColor);
    if (base) material.setBaseColorTexture(base);
    const normal = addTexture('normal', def.normal);
    if (normal) material.setNormalTexture(normal).setNormalScale(def.normalScale);
    materials.set(def.name, material);
  }

  const mesh = doc.createMesh(assetId);
  for (const part of parts) {
    const material = materials.get(part.material);
    if (!material) throw new Error(`${assetId}: part uses unknown material "${part.material}"`);
    const prim = doc.createPrimitive().setMaterial(material);
    if (part.lods) prim.setExtras({ lods: part.lods });
    prim.setIndices(accessorFor(doc, part.indices, 'SCALAR'));
    prim.setAttribute('POSITION', accessorFor(doc, part.positions, 'VEC3'));
    prim.setAttribute('NORMAL', accessorFor(doc, part.normals, 'VEC3'));
    prim.setAttribute('TEXCOORD_0', accessorFor(doc, part.uvs, 'VEC2'));
    for (const [semantic, values] of Object.entries(part.extra)) {
      prim.setAttribute(
        semantic,
        doc.createAccessor().setType('SCALAR').setArray(values).setBuffer(buffer),
      );
    }
    mesh.addPrimitive(prim);
  }
  const node = doc.createNode(assetId).setMesh(mesh);
  doc.createScene(assetId).addChild(node);
  return { doc, textures };
}

export interface EmitInput {
  outRoot: string;
  kind: AssetKind;
  id: string;
  built: BuiltDocument;
  plan: LodPlan;
  meta: Pick<
    OutputAsset,
    'species' | 'origin' | 'sources' | 'licence' | 'modifications' | 'fish' | 'shrimp'
  >;
}

function boundsOfDoc(doc: Document): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const e = [0, 0, 0];
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION')!;
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, e);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, e[a]!);
          max[a] = Math.max(max[a]!, e[a]!);
        }
      }
    }
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    min: min.map(round) as [number, number, number],
    max: max.map(round) as [number, number, number],
  };
}

export async function writeTextureEntries(
  outRoot: string,
  dir: string,
  entries: TextureEntry[],
): Promise<{ files: WrittenFile[]; textures: OutputAsset['textures'] }> {
  const files: WrittenFile[] = [];
  const textures: OutputAsset['textures'] = [];
  for (const entry of entries) {
    const variants = await encodeTiers({
      name: entry.name,
      role: entry.source.role,
      codec: entry.source.codec,
      colorSpace: entry.colorSpace,
      image: entry.source.image,
    });
    const written = {} as Record<Tier, WrittenFile & { size: number; codec: TextureCodec }>;
    for (const tier of ['1k', '2k'] as const) {
      const file = writeFileTracked(
        outRoot,
        `${dir}/${variantFileName(entry.name, tier)}`,
        variants[tier].bytes,
      );
      files.push(file);
      written[tier] = { ...file, size: variants[tier].size, codec: variants[tier].codec };
    }
    textures.push({
      name: entry.name,
      role: entry.source.role,
      colorSpace: entry.colorSpace,
      variants: { '1k': written['1k'], '2k': written['2k'] },
    });
  }
  return { files, textures };
}

export async function emitAsset(input: EmitInput): Promise<OutputAsset> {
  const { outRoot, kind, id, built, plan } = input;
  const dir = `${kind}/${id}`;
  const { files, textures: textureInfo } = await writeTextureEntries(outRoot, dir, built.textures);

  await built.doc.transform(prune());
  const lods: OutputAsset['lods'] = [];
  for (let level = 0; level < LOD_COUNT; level++) {
    const doc = cloneDocument(built.doc).setLogger(new Logger(Logger.Verbosity.WARN));
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        const lods = prim.getExtras()['lods'];
        if (Array.isArray(lods)) {
          prim.setExtras({});
          if (!lods.includes(level)) prim.dispose();
          continue;
        }
        plan.prepare?.(prim, level);
        simplifyPrimitive(prim, { ratio: plan.ratios[level]!, minTriangles: plan.minTriangles });
      }
    await doc.transform(prune());
    const textureByName = new Map(
      doc
        .getRoot()
        .listTextures()
        .map((t) => [t.getName(), t]),
    );
    bindKtx2Textures(
      doc,
      built.textures.map((t) => ({
        texture: textureByName.get(t.name)!,
        uri: variantFileName(t.name, '1k'),
      })),
    );
    let triangles = 0;
    let vertices = 0;
    for (const mesh of doc.getRoot().listMeshes())
      for (const prim of mesh.listPrimitives()) {
        triangles += triangleCountOf(prim);
        vertices += prim.getAttribute('POSITION')!.getCount();
      }
    if (triangles === 0 || vertices === 0)
      throw new Error(`${id}: LOD${level} is empty after simplification`);
    const bytes = await writeGlb(doc);
    const file = writeFileTracked(outRoot, `${dir}/lod${level}.glb`, bytes);
    files.push(file);
    lods.push({ ...file, triangles, vertices });
  }

  files.sort((a, b) => (a.file < b.file ? -1 : 1));
  return {
    id,
    kind,
    ...(input.meta.species ? { species: input.meta.species } : {}),
    origin: input.meta.origin,
    sources: input.meta.sources,
    licence: input.meta.licence,
    modifications: input.meta.modifications,
    bounds: boundsOfDoc(built.doc),
    lods,
    textures: textureInfo,
    files,
    ...(input.meta.fish ? { fish: input.meta.fish } : {}),
    ...(input.meta.shrimp ? { shrimp: input.meta.shrimp } : {}),
  };
}
