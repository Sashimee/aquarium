/**
 * A legged walker's tail-curl axis and extent, in model space; see the index's `customAttributes`.
 * A crab's index block has the shrimp's shape, its soft body standing in for the abdomen.
 */
export interface ShrimpRig {
  /** The abdomen curls about +x through this point. */
  readonly hinge: { readonly y: number; readonly z: number };
  readonly telsonZ: number;
  /**
   * Pairs of `_leg` slots the mesh may use, `pair * 2 + side`: the model's limb index range, not
   * the species' walking pereiopods (`locomotion.walking.legPairs`), which may be fewer.
   */
  readonly legPairs: number;
}

/** A fish's octahedral impostor atlas pair; see `tools/asset-pipeline/IMPOSTOR.md`. */
export interface ImpostorAtlasInfo {
  /** Frames per side; frame (i, j) looks along the octahedral grid point (i, j). */
  readonly grid: number;
  /** Pixels per frame side. */
  readonly frameSize: number;
  /** Model-space centre of every frame. */
  readonly pivot: readonly [number, number, number];
  /** Half-extent of every frame in model metres. */
  readonly radius: number;
  /** sRGB base colour and coverage; paths as `lodFiles`. */
  readonly albedoFile: string;
  /** View-space normal xy, fin mask and depth. */
  readonly normalFile: string;
}

const KINDS = ['fish', 'shrimp', 'crab', 'snail'] as const;
export type FishAssetKind = (typeof KINDS)[number];

function isFishKind(kind: unknown): kind is FishAssetKind {
  return KINDS.some((k) => k === kind);
}

export interface FishAssetEntry {
  readonly id: string;
  readonly kind: FishAssetKind;
  readonly species: string;
  /** Model-space bounds; +Z forward, +Y up, origin at the centre of mass. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Standard length the model is scaled to, in metres. */
  readonly standardLengthM: number;
  /** lod0 first, relative to the assets root. */
  readonly lodFiles: readonly string[];
  /** 1k map → its 2k map, for the maps whose 2k variant really is larger; paths as `lodFiles`. */
  readonly sharperTextures: ReadonlyMap<string, string>;
  /** Set for a shrimp or a crab; null for a fish or a snail. */
  readonly shrimp: ShrimpRig | null;
  /**
   * Height of a walker's model origin over the surface it stands on, in model units: down to the
   * feet of a shrimp or crab, 0 for a snail, whose origin is on its sole. Null for a fish.
   */
  readonly standoff: number | null;
  /** Null where the pipeline baked none, which keeps the lod2 mesh at every distance. */
  readonly impostor: ImpostorAtlasInfo | null;
}

export function fail(path: string, expected: string): never {
  throw new TypeError(`assets/index.json: ${path} must be ${expected}; re-run the asset pipeline`);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'a non-empty string');
  return value;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) {
    fail(path, 'a positive number');
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value;
}

function shrimpRig(shrimp: Record<string, unknown>, at: string): ShrimpRig {
  const hinge = record(shrimp.abdomenHinge, `${at}.abdomenHinge`);
  const rig = {
    hinge: {
      y: finite(hinge.y, `${at}.abdomenHinge.y`),
      z: finite(hinge.z, `${at}.abdomenHinge.z`),
    },
    telsonZ: finite(shrimp.telsonZ, `${at}.telsonZ`),
    legPairs: positive(shrimp.legPairs, `${at}.legPairs`),
  };
  if (!(rig.hinge.z > rig.telsonZ)) fail(`${at}.telsonZ`, 'behind the abdomen hinge');
  if (!Number.isInteger(rig.legPairs)) fail(`${at}.legPairs`, 'an integer');
  return rig;
}

function vec3(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'an array of three numbers');
  const [x, y, z] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    fail(path, 'an array of three numbers');
  }
  return [x, y, z];
}

/** Paths are joined to the assets root, so anything climbing out of it is rejected. */
function assetPath(value: unknown, path: string, extension = '.glb'): string {
  const file = string(value, path);
  if (file.startsWith('/') || file.split('/').includes('..') || !file.endsWith(extension)) {
    fail(path, `a relative ${extension} path inside the assets folder`);
  }
  return file;
}

function sharperTextures(value: unknown, path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (value === undefined) return out;
  if (!Array.isArray(value)) fail(path, 'an array');
  value.forEach((raw: unknown, i) => {
    const variants = record(record(raw, `${path}[${i}]`).variants, `${path}[${i}].variants`);
    const small = variants['1k'];
    const large = variants['2k'];
    if (small === undefined || large === undefined) return;
    const at = `${path}[${i}].variants`;
    const smallVariant = record(small, `${at}.1k`);
    const largeVariant = record(large, `${at}.2k`);
    const smallSize = positive(smallVariant.size, `${at}.1k.size`);
    const largeSize = positive(largeVariant.size, `${at}.2k.size`);
    if (largeSize <= smallSize) return;
    out.set(
      assetPath(smallVariant.file, `${at}.1k.file`, '.ktx2'),
      assetPath(largeVariant.file, `${at}.2k.file`, '.ktx2'),
    );
  });
  return out;
}

function impostorAtlas(value: unknown, at: string): ImpostorAtlasInfo | null {
  if (value === undefined) return null;
  const block = record(value, at);
  if (block.layout !== 'octahedral') fail(`${at}.layout`, '"octahedral"');
  const grid = positive(block.grid, `${at}.grid`);
  if (!Number.isInteger(grid) || grid < 3 || grid % 2 === 0)
    fail(`${at}.grid`, 'an odd integer >= 3');
  const frameSize = positive(block.frameSize, `${at}.frameSize`);
  if (!Number.isInteger(Math.log2(frameSize))) fail(`${at}.frameSize`, 'a power of two');
  const atlasSize = positive(block.atlasSize, `${at}.atlasSize`);
  if (atlasSize !== grid * frameSize) fail(`${at}.atlasSize`, 'grid * frameSize');
  const pivot = vec3(block.pivot, `${at}.pivot`);
  if (!pivot.every(Number.isFinite)) fail(`${at}.pivot`, 'three finite numbers');
  return {
    grid,
    frameSize,
    pivot,
    radius: positive(block.radius, `${at}.radius`),
    albedoFile: assetPath(record(block.albedo, `${at}.albedo`).file, `${at}.albedo.file`, '.ktx2'),
    normalFile: assetPath(
      record(block.normalDepth, `${at}.normalDepth`).file,
      `${at}.normalDepth.file`,
      '.ktx2',
    ),
  };
}

export function parseFishAssets(json: unknown): Map<string, FishAssetEntry> {
  const root = record(json, 'root');
  const assets = root.assets;
  if (!Array.isArray(assets)) fail('assets', 'an array');
  const out = new Map<string, FishAssetEntry>();
  assets.forEach((raw: unknown, i) => {
    const asset = record(raw, `assets[${i}]`);
    const kind = asset.kind;
    if (!isFishKind(kind)) return;
    const id = string(asset.id, `assets[${i}].id`);
    const at = `assets[${id}]`;
    const bounds = record(asset.bounds, `${at}.bounds`);
    const min = vec3(bounds.min, `${at}.bounds.min`);
    const max = vec3(bounds.max, `${at}.bounds.max`);
    if (!(max[2] > min[2])) fail(`${at}.bounds`, 'non-empty along z');
    const lods = asset.lods;
    if (!Array.isArray(lods) || lods.length === 0) fail(`${at}.lods`, 'a non-empty array');
    const lodFiles = lods.map((lod: unknown, j) =>
      assetPath(record(lod, `${at}.lods[${j}]`).file, `${at}.lods[${j}].file`),
    );
    const body = record(asset[kind], `${at}.${kind}`);
    const legged = kind === 'shrimp' || kind === 'crab';
    if (kind === 'snail' && body.origin !== 'foot-centre')
      fail(`${at}.snail.origin`, '"foot-centre"');
    out.set(id, {
      id,
      kind,
      species: string(asset.species, `${at}.species`),
      min,
      max,
      standardLengthM: positive(body.standardLengthM, `${at}.${kind}.standardLengthM`),
      lodFiles,
      sharperTextures: sharperTextures(asset.textures, `${at}.textures`),
      shrimp: legged ? shrimpRig(body, `${at}.${kind}`) : null,
      standoff: legged
        ? positive(body.standoffM, `${at}.${kind}.standoffM`)
        : kind === 'snail'
          ? 0
          : null,
      impostor: impostorAtlas(asset.impostor, `${at}.impostor`),
    });
  });
  return out;
}
