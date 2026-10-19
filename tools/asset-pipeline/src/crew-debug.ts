import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { LOD_COUNT } from './index-schema.ts';
import { renderSheet, type RasterMesh, type TextureImage, type View } from './raster.ts';
import type { Rgba } from './textures.ts';

type ViewSpec = { view: View; pixelsAcross: number };

const VIEWS: ViewSpec[] = [
  { view: 'side', pixelsAcross: 1100 },
  { view: 'top', pixelsAcross: 1100 },
  { view: 'front', pixelsAcross: 1100 },
];

const SMALL_VIEWS: ViewSpec[] = [
  { view: 'side', pixelsAcross: 400 },
  { view: 'top', pixelsAcross: 400 },
];

export type PartColours = (ids: Float32Array, weights: Float32Array) => Float32Array;

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * Reads the emitted LOD GLB back (meshopt-decoded) and draws exactly its triangles and UVs, so a texture
 * that no longer fits the simplified surface shows up here the way it does in the game. Textured materials
 * use the image their KTX2 was encoded from (the first one through its UVs, any further one sampled per vertex,
 * because the rasteriser binds a single texture); the rest use their base colour factor.
 */
export async function renderShippedLod(
  outRoot: string,
  dir: string,
  level: number,
  images: Record<string, Rgba>,
  views: ViewSpec[] = VIEWS,
  partColours?: PartColours,
): Promise<Buffer> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(join(outRoot, dir, `lod${level}.glb`));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let textured: TextureImage | undefined;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION')!;
      const count = position.getCount();
      const base = positions.length / 3;
      const material = prim.getMaterial()!;
      const image = images[material.getName()];
      const factor = material.getBaseColorFactor();
      const uv = prim.getAttribute('TEXCOORD_0');
      const normal = prim.getAttribute('NORMAL');
      const ids = prim.getAttribute('_FIN_ID');
      const weights = prim.getAttribute('_FIN_MASK');
      const override =
        partColours && ids && weights
          ? partColours(Float32Array.from(ids.getArray()!), Float32Array.from(weights.getArray()!))
          : undefined;
      const e = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        position.getElement(i, e);
        positions.push(e[0]!, e[1]!, e[2]!);
        if (normal) {
          normal.getElement(i, e);
          normals.push(e[0]!, e[1]!, e[2]!);
        } else normals.push(0, 1, 0);
        if (image && uv && !override && (!textured || textured.data === image.data)) {
          uv.getElement(i, e);
          uvs.push(e[0]!, e[1]!);
          colors.push(0, 0, 0);
        } else if (image && uv && !override) {
          uv.getElement(i, e);
          const x = Math.min(image.width - 1, Math.max(0, Math.floor(e[0]! * image.width)));
          const y = Math.min(image.height - 1, Math.max(0, Math.floor(e[1]! * image.height)));
          const o = (y * image.width + x) * 4;
          uvs.push(Number.NaN, Number.NaN);
          colors.push(image.data[o]! / 255, image.data[o + 1]! / 255, image.data[o + 2]! / 255);
        } else {
          uvs.push(Number.NaN, Number.NaN);
          if (override) colors.push(override[i * 3]!, override[i * 3 + 1]!, override[i * 3 + 2]!);
          else
            colors.push(linearToSrgb(factor[0]), linearToSrgb(factor[1]), linearToSrgb(factor[2]));
        }
      }
      if (image && !override && !textured)
        textured = { data: image.data, width: image.width, height: image.height, channels: 4 };
      const index = prim.getIndices()!.getArray()!;
      for (let i = 0; i < index.length; i++) indices.push(index[i]! + base);
    }
  const mesh: RasterMesh = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
  };
  return renderSheet(mesh, views, textured);
}

export async function writeShippedDebugRenders(
  repoRoot: string,
  outRoot: string,
  kind: string,
  id: string,
  images: Record<string, Rgba>,
  partColours: PartColours,
): Promise<{ textured: string; parts: string }> {
  const dir = join(repoRoot, 'tools', 'asset-pipeline', 'debug');
  mkdirSync(dir, { recursive: true });
  const assetDir = `${kind}/${id}`;
  const write = (name: string, data: Buffer): void => writeFileSync(join(dir, name), data);
  write(`${id}.png`, await renderShippedLod(outRoot, assetDir, 0, images));
  write(`${id}-lod1.png`, await renderShippedLod(outRoot, assetDir, 1, images, SMALL_VIEWS));
  write(
    `${id}-lod2.png`,
    await renderShippedLod(outRoot, assetDir, LOD_COUNT - 1, images, SMALL_VIEWS),
  );
  write(
    `${id}-parts.png`,
    await renderShippedLod(outRoot, assetDir, 0, images, VIEWS, partColours),
  );
  return { textured: `debug/${id}.png`, parts: `debug/${id}-parts.png` };
}
