export interface FishAssetEntry {
  readonly id: string;
  readonly species: string;
  /** Model-space bounds; +Z forward, +Y up, origin at the centre of mass. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Standard length the model is scaled to, in metres. */
  readonly standardLengthM: number;
  /** lod0 first, relative to the assets root. */
  readonly lodFiles: readonly string[];
}

function fail(path: string, expected: string): never {
  throw new TypeError(`assets/index.json: ${path} must be ${expected}; re-run the asset pipeline`);
}

function record(value: unknown, path: string): Record<string, unknown> {
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

function vec3(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'an array of three numbers');
  const [x, y, z] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    fail(path, 'an array of three numbers');
  }
  return [x, y, z];
}

/** Paths are joined to the assets root, so anything climbing out of it is rejected. */
function assetPath(value: unknown, path: string): string {
  const file = string(value, path);
  if (file.startsWith('/') || file.split('/').includes('..') || !file.endsWith('.glb')) {
    fail(path, 'a relative .glb path inside the assets folder');
  }
  return file;
}

export function parseFishAssets(json: unknown): Map<string, FishAssetEntry> {
  const root = record(json, 'root');
  const assets = root.assets;
  if (!Array.isArray(assets)) fail('assets', 'an array');
  const out = new Map<string, FishAssetEntry>();
  assets.forEach((raw: unknown, i) => {
    const asset = record(raw, `assets[${i}]`);
    if (asset.kind !== 'fish') return;
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
    const fish = record(asset.fish, `${at}.fish`);
    out.set(id, {
      id,
      species: string(asset.species, `${at}.species`),
      min,
      max,
      standardLengthM: positive(fish.standardLengthM, `${at}.fish.standardLengthM`),
      lodFiles,
    });
  });
  return out;
}
