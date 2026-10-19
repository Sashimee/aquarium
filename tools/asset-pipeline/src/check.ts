import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { MeshoptDecoder } from 'meshoptimizer';
import { speciesLengthM } from './fish.ts';
import { readKtx2Info } from './textures.ts';
import { FISH_RECIPES } from './recipes.ts';
import { shrimpLength } from './shrimp.ts';
import { budgetProblems, loadBudgetContent, type BudgetInput } from './budgets.ts';
import {
  FIN_ID_ATTRIBUTE,
  FIN_MASK_ATTRIBUTE,
  IMPOSTOR_FILES,
  IMPOSTOR_MAX_BYTES,
  LEG_ATTRIBUTE,
  LOD_COUNT,
  MOUTH_ATTRIBUTE,
  assetIndexSchema,
  type AssetIndex,
  type OutputAsset,
} from './index-schema.ts';
import {
  ALLOWED_LICENCES,
  isAllowedShareAlike,
  licenceRank,
  manifestSchema,
  validateManifest,
  modificationProblems,
  PENDING_STATUS,
  type Manifest,
  type ManifestAsset,
} from './manifest.ts';

await MeshoptDecoder.ready;

export const BUDGET_BYTES = 150 * 1000 * 1000;

export interface CheckInput {
  manifest: Manifest;
  credits: string;
  index: AssetIndex;
  assetsDir: string;
  repoRoot: string;
  content?: Pick<BudgetInput, 'presets' | 'speciesBiome' | 'hdri'>;
}

export function readGlbJson(buffer: Uint8Array): {
  meshes?: { primitives: { attributes: Record<string, number> }[] }[];
  images?: { uri?: string }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    count: number;
    componentType?: number;
    normalized?: boolean;
    type?: string;
  }[];
  bufferViews?: {
    byteStride?: number;
    byteOffset?: number;
    byteLength: number;
    extensions?: {
      EXT_meshopt_compression?: {
        byteOffset?: number;
        byteLength: number;
        byteStride: number;
        count: number;
        mode: string;
        filter?: string;
      };
    };
  }[];
} {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
    throw new Error('not a GLB (bad magic)');
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON');
  return JSON.parse(new TextDecoder().decode(buffer.subarray(20, 20 + jsonLength)));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function effectiveLicenceProblems(
  asset: OutputAsset,
  byId: Map<string, ManifestAsset>,
  problems: string[],
): void {
  const at = `asset ${asset.kind}/${asset.id}`;
  const known: string[] = [];
  if (
    asset.sources.length === 0 &&
    asset.origin !== 'procedural' &&
    asset.origin !== 'procedural-loft'
  ) {
    problems.push(`${at}: has no manifest sources and is not marked procedural`);
  }
  for (const sourceId of asset.sources) {
    const source = byId.get(sourceId);
    if (!source) {
      problems.push(`${at}: source "${sourceId}" is not in assets/manifest.json`);
      continue;
    }
    if (source.status === PENDING_STATUS) {
      problems.push(`${at}: source "${sourceId}" is still ${PENDING_STATUS}`);
    }
    const licenceOk =
      (ALLOWED_LICENCES as readonly string[]).includes(source.licence) ||
      isAllowedShareAlike(source);
    if (!licenceOk)
      problems.push(`${at}: source "${sourceId}" has disallowed licence ${source.licence}`);
    if (licenceOk) known.push(source.licence);
  }
  if (
    asset.origin === 'procedural' ||
    (asset.origin === 'procedural-loft' && asset.sources.length === 0)
  ) {
    if (asset.licence !== 'CC0-1.0') {
      problems.push(
        `${at}: procedural asset without sources must be CC0-1.0 (got ${asset.licence})`,
      );
    }
    return;
  }
  if (known.length === 0 || known.length !== asset.sources.length) return;
  const strictest = Math.max(...known.map((l) => licenceRank(l) ?? 0));
  const acceptable = known.filter((l) => licenceRank(l) === strictest);
  if (!acceptable.includes(asset.licence)) {
    problems.push(
      `${at}: licence ${asset.licence} is weaker than its sources require (${acceptable.join(' or ')})`,
    );
  }
}

const TEXTURE_ONLY_KINDS: readonly string[] = ['substrate', 'hdri'];

function safeDecodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

const SHIPPED_EXTENSIONS: readonly string[] = ['.glb', '.ktx2'];

function requiredAttributes(kind: OutputAsset['kind']): string[] {
  if (kind === 'fish') return ['TEXCOORD_0', FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE, MOUTH_ATTRIBUTE];
  if (kind === 'shrimp') return [FIN_MASK_ATTRIBUTE, FIN_ID_ATTRIBUTE, LEG_ATTRIBUTE];
  return [];
}

function readGlbBin(buffer: Uint8Array): Uint8Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const binStart = 20 + view.getUint32(12, true) + 8;
  if (buffer.byteLength < binStart || view.getUint32(binStart - 4, true) !== 0x004e4942)
    throw new Error('second GLB chunk is not BIN');
  return buffer.subarray(binStart, binStart + view.getUint32(binStart - 8, true));
}

function readFloatAccessor(
  json: ReturnType<typeof readGlbJson>,
  bin: Uint8Array,
  index: number,
): Float32Array {
  const accessor = json.accessors?.[index];
  const view =
    accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
  if (!accessor || !view) throw new Error(`accessor ${index} has no buffer view`);
  if (accessor.componentType !== 5126 || accessor.normalized || accessor.type !== 'SCALAR')
    throw new Error(
      `accessor ${index} must be non-normalised float32 SCALAR (got componentType ${accessor.componentType}, normalized ${accessor.normalized ?? false}, type ${accessor.type}); the check reads raw floats`,
    );
  if (view.byteStride !== undefined && view.byteStride !== 4)
    throw new Error(
      `accessor ${index} has byteStride ${view.byteStride}; the check needs a tightly packed float32 view`,
    );
  if (
    view.extensions?.EXT_meshopt_compression?.byteStride !== undefined &&
    view.extensions.EXT_meshopt_compression.byteStride !== 4
  )
    throw new Error(
      `accessor ${index} has a meshopt byteStride other than 4; the check needs a tightly packed float32 view`,
    );
  const compressed = view.extensions?.EXT_meshopt_compression;
  let bytes: Uint8Array;
  if (compressed) {
    bytes = new Uint8Array(compressed.count * compressed.byteStride);
    const source = bin.subarray(
      compressed.byteOffset ?? 0,
      (compressed.byteOffset ?? 0) + compressed.byteLength,
    );
    MeshoptDecoder.decodeGltfBuffer(
      bytes,
      compressed.count,
      compressed.byteStride,
      source,
      compressed.mode,
      compressed.filter ?? 'NONE',
    );
  } else {
    bytes = bin.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  const start = accessor.byteOffset ?? 0;
  return new Float32Array(bytes.buffer, bytes.byteOffset + start, accessor.count);
}

function mouthProblems(
  json: ReturnType<typeof readGlbJson>,
  bin: Uint8Array,
  primitives: { attributes: Record<string, number> }[],
  at: string,
  problems: string[],
): void {
  let low = Infinity;
  let high = -Infinity;
  for (const primitive of primitives) {
    const index = primitive.attributes[MOUTH_ATTRIBUTE];
    if (index === undefined) continue;
    for (const value of readFloatAccessor(json, bin, index)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return;
  if (low < 0 || high > 1)
    problems.push(`${at}: ${MOUTH_ATTRIBUTE} range ${low}..${high} is outside 0..1`);
  else if (high <= 0)
    problems.push(`${at}: ${MOUTH_ATTRIBUTE} is 0 on every vertex; the mouth mask was not baked`);
}

function lodProblems(asset: OutputAsset, assetsDir: string, problems: string[]): void {
  const at = `${asset.kind} ${asset.id}`;
  const owned = new Set(asset.files.map((f) => f.file));
  if (asset.lods.length !== LOD_COUNT) {
    problems.push(`${at}: needs ${LOD_COUNT} LODs, index lists ${asset.lods.length}`);
  }
  for (let i = 0; i < LOD_COUNT; i++) {
    const lod = asset.lods[i];
    const expected = `${asset.kind}/${asset.id}/lod${i}.glb`;
    if (!lod || lod.file !== expected) {
      problems.push(`${at}: LOD ${i} must be ${expected}`);
      continue;
    }
    const path = join(assetsDir, lod.file);
    if (!existsSync(path)) {
      problems.push(`${at}: ${lod.file} is missing`);
      continue;
    }
    try {
      const bytes = readFileSync(path);
      const json = readGlbJson(bytes);
      const primitives = (json.meshes ?? []).flatMap((m) => m.primitives);
      if (primitives.length === 0) problems.push(`${at}: ${lod.file} has no mesh primitives`);
      for (const image of json.images ?? []) {
        if (image.uri === undefined) continue;
        const target = posix.join(posix.dirname(lod.file), safeDecodeUri(image.uri));
        if (!owned.has(target)) {
          problems.push(
            `${at}: ${lod.file} references ${image.uri}, which is not in the asset's files (embedded data: URIs are not allowed either)`,
          );
        }
      }
      for (const attr of requiredAttributes(asset.kind)) {
        if (primitives.some((p) => p.attributes[attr] === undefined)) {
          problems.push(`${at}: ${lod.file} lacks vertex attribute ${attr}`);
        }
      }
      if (asset.kind === 'fish')
        mouthProblems(json, readGlbBin(bytes), primitives, `${at}: ${lod.file}`, problems);
    } catch (error) {
      problems.push(`${at}: ${lod.file} is unreadable: ${(error as Error).message}`);
    }
    const previous = asset.lods[i - 1];
    if (previous && lod.triangles >= previous.triangles) {
      problems.push(`${at}: LOD ${i} (${lod.triangles} tris) is not lighter than LOD ${i - 1}`);
    }
  }
}

function fishProblems(asset: OutputAsset, repoRoot: string, problems: string[]): void {
  const at = `fish ${asset.id}`;
  if (!asset.fish) {
    problems.push(`${at}: index entry has no fish block (fin mask, standard length)`);
    return;
  }
  if (!existsSync(join(repoRoot, 'tools', 'asset-pipeline', asset.fish.debugRender))) {
    problems.push(`${at}: debug render ${asset.fish.debugRender} is missing`);
  }
  const speciesLength = asset.species ? speciesLengthM(repoRoot, asset.species) : null;
  if (speciesLength === null) {
    if (asset.fish.lengthSource === 'species-json') {
      problems.push(
        `${at}: built with lengthSource species-json but content/species/${asset.species}.json has no bodyLengthM (rebuild with pnpm build:assets)`,
      );
    }
    return;
  }
  const lengthFactor = FISH_RECIPES.find((r) => r.id === asset.id)?.lengthFactor ?? 1;
  const expectedLength = speciesLength * lengthFactor;
  if (asset.fish.lengthSource !== 'species-json') {
    problems.push(
      `${at}: built with lengthSource ${asset.fish.lengthSource} but content/species/${asset.species}.json has bodyLengthM ${speciesLength} (rebuild with pnpm build:assets)`,
    );
  } else if (Math.abs(asset.fish.standardLengthM - expectedLength) > 1e-9) {
    problems.push(
      `${at}: standardLengthM ${asset.fish.standardLengthM} differs from content/species/${asset.species}.json bodyLengthM ${speciesLength} x ${lengthFactor} (rebuild with pnpm build:assets)`,
    );
  }
}

const ETC1S_COLOR_MODEL = 163;
const UASTC_COLOR_MODEL = 166;
const TRANSFER_LINEAR = 1;
const TRANSFER_SRGB = 2;

function impostorProblems(asset: OutputAsset, assetsDir: string, problems: string[]): void {
  const at = `fish ${asset.id}`;
  const impostor = asset.impostor;
  if (!impostor) {
    problems.push(`${at}: index entry has no impostor atlas (rebuild with pnpm build:assets)`);
    return;
  }
  if (impostor.grid * impostor.frameSize !== impostor.atlasSize) {
    problems.push(
      `${at}: impostor atlasSize ${impostor.atlasSize} is not grid ${impostor.grid} x frameSize ${impostor.frameSize}`,
    );
  }
  const owned = new Set(asset.files.map((f) => f.file));
  const atlases = [
    {
      slot: 'albedo',
      entry: impostor.albedo,
      colorModel: ETC1S_COLOR_MODEL,
      transfer: TRANSFER_SRGB,
    },
    {
      slot: 'normalDepth',
      entry: impostor.normalDepth,
      colorModel: UASTC_COLOR_MODEL,
      transfer: TRANSFER_LINEAR,
    },
  ] as const;
  for (const { slot, entry, colorModel, transfer } of atlases) {
    const expected = `${asset.kind}/${asset.id}/${IMPOSTOR_FILES[slot]}`;
    if (entry.file !== expected) problems.push(`${at}: impostor ${slot} must be ${expected}`);
    if (!owned.has(entry.file)) {
      problems.push(`${at}: ${entry.file} is referenced but not in files[]`);
      continue;
    }
    const path = join(assetsDir, entry.file);
    if (!existsSync(path)) continue;
    try {
      const info = readKtx2Info(new Uint8Array(readFileSync(path)));
      if (info.width !== impostor.atlasSize || info.height !== impostor.atlasSize) {
        problems.push(
          `${at}: ${entry.file} is ${info.width}x${info.height}, index says ${impostor.atlasSize}x${impostor.atlasSize}`,
        );
      }
      if (info.colorModel !== colorModel) {
        problems.push(
          `${at}: ${entry.file} must be ${colorModel === UASTC_COLOR_MODEL ? 'UASTC' : 'ETC1S'} (colour model ${info.colorModel})`,
        );
      }
      if (info.transfer !== transfer) {
        problems.push(
          `${at}: ${entry.file} must use the ${transfer === TRANSFER_SRGB ? 'sRGB' : 'linear'} transfer function`,
        );
      }
    } catch (error) {
      problems.push(`${at}: ${entry.file} is unreadable: ${(error as Error).message}`);
    }
  }
  const bytes = impostor.albedo.bytes + impostor.normalDepth.bytes;
  if (bytes > IMPOSTOR_MAX_BYTES) {
    problems.push(
      `${at}: impostor atlases are ${(bytes / 1e6).toFixed(2)} MB, over the ${IMPOSTOR_MAX_BYTES / 1e6} MB per-species budget`,
    );
  }
  const { bounds } = asset;
  if (bounds) {
    const reach = [0, 1, 2].map((a) =>
      Math.max(
        Math.abs((bounds.max[a] ?? 0) - (impostor.pivot[a] ?? 0)),
        Math.abs((impostor.pivot[a] ?? 0) - (bounds.min[a] ?? 0)),
      ),
    );
    const farthest = Math.hypot(...reach);
    if (impostor.radius < Math.max(...reach) * 0.95 || impostor.radius > farthest * 1.1) {
      problems.push(
        `${at}: impostor radius ${impostor.radius} does not fit the model bounds about pivot [${impostor.pivot.join(', ')}] (rebuild with pnpm build:assets)`,
      );
    }
  }
}

function shrimpProblems(asset: OutputAsset, repoRoot: string, problems: string[]): void {
  const at = `shrimp ${asset.id}`;
  if (!asset.shrimp) {
    problems.push(`${at}: index entry has no shrimp block (part ids, rig, standard length)`);
    return;
  }
  for (const render of [asset.shrimp.debugRender, asset.shrimp.debugPartsRender]) {
    if (!existsSync(join(repoRoot, 'tools', 'asset-pipeline', render)))
      problems.push(`${at}: debug render ${render} is missing`);
  }
  const expected = asset.species ? shrimpLength(repoRoot, asset.species) : null;
  if (expected === null) return;
  if (asset.shrimp.lengthSource !== 'species-json') {
    problems.push(
      `${at}: built with lengthSource ${asset.shrimp.lengthSource} but the species JSON has bodyLengthM ${expected.metres} (rebuild with pnpm build:assets)`,
    );
  } else if (Math.abs(asset.shrimp.standardLengthM - expected.metres) > 1e-9) {
    problems.push(
      `${at}: standardLengthM ${asset.shrimp.standardLengthM} differs from the species JSON bodyLengthM ${expected.metres} (rebuild with pnpm build:assets)`,
    );
  }
}

export function checkAssets(input: CheckInput): string[] {
  const { manifest, credits, index, assetsDir, repoRoot } = input;
  const problems = validateManifest(manifest, credits);
  problems.push(...modificationProblems(index, manifest));
  const byId = new Map(manifest.assets.map((a) => [a.id, a]));

  const listed = new Map<string, string>();
  const seenAssets = new Set<string>();
  for (const asset of index.assets) {
    const key = `${asset.kind}/${asset.id}`;
    if (seenAssets.has(key)) problems.push(`index lists ${key} twice`);
    seenAssets.add(key);
    effectiveLicenceProblems(asset, byId, problems);
    if (!TEXTURE_ONLY_KINDS.includes(asset.kind)) lodProblems(asset, assetsDir, problems);
    if (asset.kind === 'fish') {
      fishProblems(asset, repoRoot, problems);
      impostorProblems(asset, assetsDir, problems);
    }
    if (asset.kind === 'shrimp') shrimpProblems(asset, repoRoot, problems);

    for (const file of asset.files) {
      if (!file.file.startsWith(`${asset.kind}/${asset.id}/`)) {
        problems.push(`${key}: file ${file.file} is outside the asset directory`);
      }
      const previous = listed.get(file.file);
      if (previous !== undefined && previous !== key) {
        problems.push(`file ${file.file} is claimed by both ${previous} and ${key}`);
      }
      listed.set(file.file, key);
      if (!SHIPPED_EXTENSIONS.some((extension) => file.file.endsWith(extension))) {
        problems.push(
          `${key}: ${file.file} is not a ${SHIPPED_EXTENSIONS.join(' or ')} file; PLAN section 3 commits only processed GLB and KTX2`,
        );
      }
      const path = join(assetsDir, file.file);
      if (!existsSync(path)) {
        problems.push(`${key}: ${file.file} is listed in index.json but missing on disk`);
      } else if (statSync(path).size !== file.bytes || sha256File(path) !== file.sha256) {
        problems.push(
          `${key}: ${file.file} differs from index.json (rebuild with pnpm build:assets)`,
        );
      }
    }
    const referenced = [
      ...asset.lods.map((l) => l.file),
      ...asset.textures.flatMap((t) => [t.variants['1k'].file, t.variants['2k'].file]),
      ...(asset.impostor ? [asset.impostor.albedo.file, asset.impostor.normalDepth.file] : []),
    ];
    const owned = new Set(asset.files.map((f) => f.file));
    for (const file of referenced) {
      if (!owned.has(file)) problems.push(`${key}: ${file} is referenced but not in files[]`);
    }
  }

  let total = 0;
  let assetBytes = 0;
  if (existsSync(assetsDir)) {
    for (const path of listFiles(assetsDir)) {
      const rel = relative(assetsDir, path).split(sep).join(posix.sep);
      const size = statSync(path).size;
      total += size;
      if (rel === 'index.json') continue;
      assetBytes += size;
      if (!listed.has(rel)) {
        problems.push(`assets/${rel} is not part of any asset in index.json (not in the manifest)`);
      }
    }
  }
  if (total > BUDGET_BYTES) {
    problems.push(
      `asset total ${(total / 1e6).toFixed(1)} MB exceeds the ${BUDGET_BYTES / 1e6} MB budget`,
    );
  }
  if (index.totalBytes !== assetBytes) {
    problems.push(
      `index.json totalBytes ${index.totalBytes} does not match the files on disk (rebuild with pnpm build:assets)`,
    );
  }
  if (input.content) problems.push(...budgetProblems({ index, ...input.content }));
  return problems;
}

export function loadCheckInput(repoRoot: string): CheckInput {
  const assetsDir = join(repoRoot, 'apps', 'web', 'public', 'assets');
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'assets', 'manifest.json'), 'utf8')),
  );
  const credits = readFileSync(join(repoRoot, 'CREDITS.md'), 'utf8');
  const indexPath = join(assetsDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`${indexPath} is missing; run pnpm build:assets`);
  }
  const index = assetIndexSchema.parse(JSON.parse(readFileSync(indexPath, 'utf8')));
  return { manifest, credits, index, assetsDir, repoRoot, content: loadBudgetContent(repoRoot) };
}
