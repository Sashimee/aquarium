import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Document, NodeIO, type Texture } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { EncodedVariant, Tier } from './textures.ts';

export async function readyCodecs(): Promise<void> {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function pad(bytes: Uint8Array, fill: number): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
  padded.set(bytes);
  return padded;
}

export function packGlb(json: object, bin: Uint8Array): Uint8Array {
  const jsonChunk = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const total = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonChunk, 20);
  const binOffset = 20 + jsonChunk.byteLength;
  view.setUint32(binOffset, binChunk.byteLength, true);
  view.setUint32(binOffset + 4, CHUNK_BIN, true);
  out.set(binChunk, binOffset + 8);
  return out;
}

export interface TextureBinding {
  texture: Texture;
  uri: string;
}

/** Marks textures as external KTX2 files so the GLB references them by relative uri. */
export function bindKtx2Textures(doc: Document, bindings: TextureBinding[]): void {
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  for (const { texture, uri } of bindings) {
    texture.setMimeType('image/ktx2').setURI(uri).setImage(new Uint8Array(4));
  }
}

/**
 * Serialises with EXT_meshopt_compression using the FILTER method, which leaves POSITION and TEXCOORD_0 unquantised so positions stay in real metres
 * (the shader spine wave and sway need undistorted units).
 */
export async function writeGlb(doc: Document): Promise<Uint8Array> {
  await readyCodecs();
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRTextureBasisu])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const { json, resources } = await io.writeJSON(doc);
  const buffers = json.buffers ?? [];
  const main = buffers.find((b) => b.uri && resources[b.uri]);
  if (!main?.uri) throw new Error('writeGlb: document produced no binary buffer');
  const bin = resources[main.uri];
  if (!bin) throw new Error('writeGlb: binary buffer resource is missing');
  delete main.uri;
  return packGlb(json, bin);
}

export interface WrittenFile {
  file: string;
  bytes: number;
  sha256: string;
}

export function writeFileTracked(root: string, relative: string, data: Uint8Array): WrittenFile {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return { file: relative, bytes: data.byteLength, sha256: sha256(data) };
}

export function variantFileName(name: string, tier: Tier): string {
  return `textures/${name}_${tier}.ktx2`;
}

export function variantTotal(variants: Record<Tier, EncodedVariant>): number {
  return variants['1k'].bytes.byteLength + variants['2k'].bytes.byteLength;
}
