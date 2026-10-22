import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { mulberry32 } from './anemone.ts';
import { loadEnvironment, sceneBaseColor, type EnvironmentRecipe } from './environment.ts';
import type { FishContext } from './fish.ts';
import { developRender, type DepthParams, type WaterPalette } from './misty-lake.ts';
import { MANGROVE_ENVIRONMENT_RECIPES } from './mangrove.ts';
import type { MaterialDef } from './parts.ts';
import { ENVIRONMENT_RECIPES } from './recipes.ts';
import {
  buildMips,
  groundMesh,
  renderScene,
  type Instance,
  type MipTexture,
  type Rendered,
  type SceneCamera,
  type SceneMesh,
  type SceneSpec,
} from './soft-render.ts';
import { RAW_ROOT } from './source.ts';
import { decodeImage, resizeImage, type Rgba } from './textures.ts';

const GREY_TEXEL: MipTexture = buildMips({
  width: 1,
  height: 1,
  data: Uint8Array.from([128, 128, 128, 255]),
});

export const WATER_WIDTH = 4096;
export const BLACKWATER_BACKGROUND_IDS = [
  'bg-blackwater-leaf-litter',
  'bg-blackwater-root-tangle',
  'bg-blackwater-driftwood-wall',
  'bg-blackwater-flooded-forest',
  'bg-blackwater-open-tannin',
] as const;
export const MANGROVE_BACKGROUND_IDS = [
  'bg-mangrove-prop-root-thicket',
  'bg-mangrove-red-roots',
  'bg-mangrove-petrified-stump',
  'bg-mangrove-tidal-flat',
  'bg-mangrove-open-water',
] as const;
export const WATER_BACKGROUND_IDS = [
  ...BLACKWATER_BACKGROUND_IDS,
  ...MANGROVE_BACKGROUND_IDS,
] as const;
export type WaterBackgroundId = (typeof WATER_BACKGROUND_IDS)[number];

export function waterRenderPath(id: string): string {
  return join(RAW_ROOT, id, 'render.png');
}

const DEPTH: DepthParams = { near: 1.5, far: 22, focus: 4.5 };

const TANNIN_WATER: WaterPalette = {
  absorption: [0.07, 0.17, 0.42],
  veilDensity: 0.16,
  veilTop: [128, 78, 34],
  veilBottom: [20, 10, 5],
  rayColour: [226, 168, 96],
  rayStrength: 0.16,
};

const BRACKISH_WATER: WaterPalette = {
  absorption: [0.2, 0.09, 0.24],
  veilDensity: 0.2,
  veilTop: [92, 104, 54],
  veilBottom: [14, 22, 12],
  rayColour: [214, 224, 160],
  rayStrength: 0.2,
};

type Vec3 = readonly [number, number, number];
type Tint = readonly [number, number, number];

const ROOT_SCAN_RECIPE: EnvironmentRecipe = {
  id: 'mangrove-root-scan',
  kind: 'decor',
  sourceId: 'sketchfab-5658cc51',
  gltf: 'gltf/scene.gltf',
  longestM: 1,
  maxTriangles: 1,
  modifications: [],
};

const MODEL_RECIPES = {
  scanA: 'driftwood-scan-a',
  scanB: 'driftwood-scan-b',
  twigs: 'dry-branches',
  trunk02: 'dead-tree-trunk-02',
  quiver: 'dead-quiver-trunk',
  propRoots: 'mangrove-prop-roots',
  stump: 'mangrove-stump',
  propagule: 'mangrove-propagule',
  rock: 'malawi-rock-07',
  rootScan: 'mangrove-root-scan',
} as const;

const CLIPPED_SCANS: Record<
  string,
  Pick<EnvironmentRecipe, 'clipBelowFraction' | 'keepUncroppedScale'>
> = {
  'driftwood-scan-b': { clipBelowFraction: 0.4, keepUncroppedScale: true },
};

type ModelName = keyof typeof MODEL_RECIPES;

export interface Library {
  models: Record<ModelName, SceneMesh[]>;
  litter: MipTexture;
  mud: MipTexture;
  mudSand: MipTexture;
}

const TEXTURE_PX = 2048;

async function loadMeshes(
  recipe: EnvironmentRecipe,
  ctx: Pick<FishContext, 'verifySource'>,
): Promise<SceneMesh[]> {
  const { parts, materials } = await loadEnvironment(recipe, ctx);
  const byName = new Map<string, MaterialDef>(materials.map((m) => [m.name, m]));
  const textures = new Map<string, MipTexture>();
  const out: SceneMesh[] = [];
  for (const part of parts) {
    const material = byName.get(part.material);
    let texture = textures.get(part.material);
    if (!texture) {
      const baseColor = sceneBaseColor(material, part.material, recipe.id);
      texture = baseColor ? buildMips(await resizeImage(baseColor.image, TEXTURE_PX)) : GREY_TEXEL;
      textures.set(part.material, texture);
    }
    const factor = material?.baseColorFactor ?? [1, 1, 1, 1];
    out.push({
      positions: part.positions,
      normals: part.normals,
      uvs: part.uvs,
      indices: part.indices,
      texture,
      tint: [factor[0], factor[1], factor[2]] as const,
      castsShadow: true,
    });
  }
  return out;
}

function recipeFor(id: string): EnvironmentRecipe {
  const recipe = [...ENVIRONMENT_RECIPES, ...MANGROVE_ENVIRONMENT_RECIPES, ROOT_SCAN_RECIPE].find(
    (r) => r.id === id,
  );
  if (!recipe) throw new Error(`no environment recipe ${id}`);
  return CLIPPED_SCANS[id] ? { ...recipe, ...CLIPPED_SCANS[id] } : recipe;
}

async function readRaw(file: string, maxDim: number): Promise<Rgba> {
  const path = join(RAW_ROOT, file);
  if (!existsSync(path)) throw new Error(`${path} is missing; run the asset downloads first`);
  return resizeImage(await decodeImage(readFileSync(path)), maxDim);
}

const LITTER_PX = 2048;

function toRgba(data: Buffer, size: number): Rgba {
  return { width: size, height: size, data: new Uint8Array(data) };
}

async function leafLitterTexture(): Promise<MipTexture> {
  const base = await readRaw(
    'ambientcg-ScatteredLeaves009/ScatteredLeaves009_2K-JPG_Color.jpg',
    LITTER_PX,
  );
  const decay = await readRaw('polyhaven-dry_decay_leaves/dry_decay_leaves_diff_2k.jpg', LITTER_PX);
  const mix = Buffer.from(base.data);
  for (let i = 0; i < mix.length; i += 4)
    for (let c = 0; c < 3; c++)
      mix[i + c] = Math.round((base.data[i + c] ?? 0) * 0.6 + (decay.data[i + c] ?? 0) * 0.4);
  const rng = mulberry32(2210);
  const cards: OverlayOptions[] = [];
  for (const set of ['LeafSet015', 'LeafSet030']) {
    const colour = await readRaw(`ambientcg-${set}/${set}_2K-JPG_Color.jpg`, 1024);
    const opacity = await readRaw(`ambientcg-${set}/${set}_2K-JPG_Opacity.jpg`, 1024);
    const rgba = Buffer.from(colour.data);
    for (let i = 0; i < colour.width * colour.height; i++)
      rgba[i * 4 + 3] = opacity.data[i * 4] ?? 0;
    for (let n = 0; n < 9; n++) {
      const size = Math.round(220 + rng() * 420);
      const card = await sharp(rgba, {
        raw: { width: colour.width, height: colour.height, channels: 4 },
      })
        .resize(size, size)
        .modulate({ saturation: 0.5 })
        .rotate(rng() * 360, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const side = Math.ceil(size * 1.42);
      cards.push({
        input: card,
        left: Math.round(rng() * (LITTER_PX - side)),
        top: Math.round(rng() * (LITTER_PX - side)),
      });
    }
  }
  const out = await sharp(mix, { raw: { width: LITTER_PX, height: LITTER_PX, channels: 4 } })
    .composite(cards)
    .raw()
    .toBuffer();
  return buildMips(toRgba(out, LITTER_PX));
}

async function mudSandTexture(mud: Rgba): Promise<MipTexture> {
  const sand = await readRaw('polyhaven-coast_sand_04/coast_sand_04_diff_2k.jpg', mud.width);
  const size = mud.width;
  const out = Buffer.alloc(size * size * 4);
  const cells = 6;
  const lattice = new Float32Array(cells * cells);
  const rng = mulberry32(5150);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const at = (x: number, y: number): number =>
    lattice[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)] ?? 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const gy = (y / size) * cells;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const n =
        at(x0, y0) * (1 - sx) * (1 - sy) +
        at(x0 + 1, y0) * sx * (1 - sy) +
        at(x0, y0 + 1) * (1 - sx) * sy +
        at(x0 + 1, y0 + 1) * sx * sy;
      const t = Math.max(0, Math.min(1, (n - 0.55) * 7));
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++)
        out[i + c] = Math.round(
          (mud.data[i + c] ?? 0) * (1 - t) + (sand.data[i + c] ?? 0) * t * 0.8,
        );
      out[i + 3] = 255;
    }
  return buildMips(toRgba(out, size));
}

const GROUND_SOURCES = [
  'ambientcg-ScatteredLeaves009',
  'polyhaven-dry_decay_leaves',
  'ambientcg-LeafSet015',
  'ambientcg-LeafSet030',
  'polyhaven-brown_mud_03',
  'polyhaven-coast_sand_04',
] as const;

async function loadLibrary(ctx: Pick<FishContext, 'verifySource'>): Promise<Library> {
  for (const sourceId of GROUND_SOURCES) ctx.verifySource(sourceId);
  const models = {} as Record<ModelName, SceneMesh[]>;
  for (const [name, id] of Object.entries(MODEL_RECIPES) as [ModelName, string][])
    models[name] = await loadMeshes(recipeFor(id), ctx);
  const mudImage = await readRaw('polyhaven-brown_mud_03/brown_mud_03_diff_2k.jpg', 1024);
  return {
    models,
    litter: await leafLitterTexture(),
    mud: buildMips(mudImage),
    mudSand: await mudSandTexture(mudImage),
  };
}

function place(
  meshes: SceneMesh[],
  position: Vec3,
  yawDeg: number,
  scale: number,
  tint?: Tint,
): Instance[] {
  return meshes.map((mesh) => ({
    mesh: tint ? { ...mesh, tint: mesh.tint ? mul(mesh.tint, tint) : tint } : mesh,
    position,
    yawDeg,
    scale,
  }));
}

function mul(a: Tint, b: Tint): Tint {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function floor(texture: MipTexture, camera: SceneCamera, tint: Tint, tile = 1.6): Instance {
  return {
    mesh: {
      ...groundMesh({
        halfWidth: 70,
        zNear: camera.position[2] - 0.4,
        zFar: -45,
        tile,
        texture,
        steps: 160,
      }),
      tint,
    },
    position: [0, 0, 0],
    yawDeg: 0,
    scale: 1,
  };
}

interface SceneBuilder {
  camera: SceneCamera;
  lighting: SceneSpec['lighting'];
  focus: number;
  palette: WaterPalette;
  empty: Vec3;
  instances: (lib: Library, camera: SceneCamera) => Instance[];
}

const BLACK_LIGHT = { ambient: 0.75, diffuse: 0.8, shadowStrength: 0.65 };
const MANGROVE_LIGHT = { ambient: 0.65, diffuse: 0.8, shadowStrength: 0.65 };

const TANNIN_LITTER: Tint = [0.9, 0.74, 0.5];
const TANNIN_WOOD: Tint = [0.92, 0.72, 0.52];
const MUD_TINT: Tint = [0.85, 0.82, 0.62];
const ROOT_RED: Tint = [1.15, 0.78, 0.62];
const ROOT_GREEN: Tint = [0.85, 0.95, 0.7];

function scatter(
  rng: () => number,
  meshes: SceneMesh[],
  count: number,
  area: { x0: number; x1: number; z0: number; z1: number },
  scale: [number, number],
  tint?: Tint,
  lift = 0.012,
): Instance[] {
  const out: Instance[] = [];
  for (let i = 0; i < count; i++)
    out.push(
      ...place(
        meshes,
        [area.x0 + rng() * (area.x1 - area.x0), lift, area.z0 + rng() * (area.z1 - area.z0)],
        rng() * 360,
        scale[0] + rng() * (scale[1] - scale[0]),
        tint,
      ),
    );
  return out;
}

const SCENES: Record<WaterBackgroundId, SceneBuilder> = {
  'bg-blackwater-leaf-litter': {
    camera: { position: [0, 0.38, 3], pitchDeg: 5, hfovDeg: 62, near: 0.25 },
    lighting: { ...BLACK_LIGHT, toLight: [-0.35, 0.85, 0.4] },
    focus: 3.2,
    palette: TANNIN_WATER,
    empty: [110, 70, 36],
    instances: (lib, cam) => {
      const rng = mulberry32(4901);
      return [
        floor(lib.litter, cam, TANNIN_LITTER, 1.1),
        ...scatter(
          rng,
          lib.models.twigs,
          16,
          { x0: -2.6, x1: 2.6, z0: 1.6, z1: -4 },
          [3, 6],
          TANNIN_WOOD,
        ),
        ...scatter(
          rng,
          lib.models.twigs,
          10,
          { x0: -6, x1: 6, z0: -4, z1: -12 },
          [5, 9],
          TANNIN_WOOD,
        ),
        ...place(lib.models.quiver, [-2.4, 0, -7], 70, 9, TANNIN_WOOD),
        ...place(lib.models.trunk02, [3.4, 0, -9], 200, 10, TANNIN_WOOD),
      ];
    },
  },
  'bg-blackwater-root-tangle': {
    camera: { position: [0, 0.8, 3.3], pitchDeg: 3, hfovDeg: 60, near: 0.3 },
    lighting: { ...BLACK_LIGHT, toLight: [0.4, 0.85, 0.4] },
    focus: 4.2,
    palette: TANNIN_WATER,
    empty: [110, 70, 36],
    instances: (lib, cam) => {
      const rng = mulberry32(4902);
      return [
        floor(lib.litter, cam, TANNIN_LITTER, 1.3),
        ...place(lib.models.scanA, [-1.9, 0, -1.5], 15, 10, TANNIN_WOOD),
        ...place(lib.models.scanA, [-2.3, 0.45, -1.9], 165, 9, TANNIN_WOOD),
        ...place(lib.models.scanA, [-1.5, 0.9, -2.1], 40, 8, TANNIN_WOOD),
        ...place(lib.models.scanA, [-3.0, 0.3, -1.0], 100, 8, TANNIN_WOOD),
        ...place(lib.models.scanA, [-1.2, 0.2, -3.6], 290, 9, TANNIN_WOOD),
        ...scatter(
          rng,
          lib.models.twigs,
          9,
          { x0: -3.4, x1: -0.4, z0: 0.6, z1: -2.2 },
          [3, 5],
          TANNIN_WOOD,
        ),
        ...scatter(
          rng,
          lib.models.twigs,
          4,
          { x0: 1.4, x1: 3.2, z0: -1, z1: -4 },
          [3, 5],
          TANNIN_WOOD,
        ),
        ...place(lib.models.trunk02, [3.8, 0, -8], 100, 10, TANNIN_WOOD),
      ];
    },
  },
  'bg-blackwater-driftwood-wall': {
    camera: { position: [0, 0.8, 3.2], pitchDeg: 3, hfovDeg: 60, near: 0.3 },
    lighting: { ...BLACK_LIGHT, toLight: [-0.4, 0.85, 0.4] },
    focus: 4,
    palette: TANNIN_WATER,
    empty: [110, 70, 36],
    instances: (lib, cam) => {
      const rng = mulberry32(4903);
      const out: Instance[] = [floor(lib.litter, cam, TANNIN_LITTER, 1.3)];
      const flanks = [
        { x0: -3.8, x1: -1.1, z: -1.5 },
        { x0: 1.1, x1: 3.8, z: -1.7 },
      ];
      for (const flank of flanks)
        for (let layer = 0; layer < 3; layer++)
          for (let x = flank.x0; x < flank.x1; x += 1.05)
            out.push(
              ...place(
                lib.models.scanB,
                [
                  x + (rng() - 0.5) * 0.3,
                  layer * 0.62 - 0.08,
                  flank.z - layer * 0.35 + (rng() - 0.5) * 0.2,
                ],
                rng() * 360,
                5.5 + rng() * 1.5,
                TANNIN_WOOD,
              ),
            );
      out.push(
        ...scatter(
          rng,
          lib.models.twigs,
          5,
          { x0: -1, x1: 1, z0: -1, z1: -3 },
          [3, 5],
          TANNIN_WOOD,
        ),
      );
      return out;
    },
  },
  'bg-blackwater-flooded-forest': {
    camera: { position: [0, 0.9, 3.4], pitchDeg: 2, hfovDeg: 62, near: 0.3 },
    lighting: { ...BLACK_LIGHT, toLight: [0.3, 0.9, 0.3] },
    focus: 5.5,
    palette: TANNIN_WATER,
    empty: [110, 70, 36],
    instances: (lib, cam) => {
      const rng = mulberry32(4904);
      const out: Instance[] = [floor(lib.litter, cam, TANNIN_LITTER, 1.4)];
      const trunks = [
        [lib.models.trunk02, -3.2, -2.4, 9],
        [lib.models.quiver, 2.6, -3.0, 11],
        [lib.models.trunk02, -0.6, -5.5, 12],
        [lib.models.quiver, -4.6, -6.5, 12],
        [lib.models.trunk02, 4.8, -7.5, 12],
        [lib.models.quiver, 1.2, -9.5, 14],
        [lib.models.trunk02, -2.8, -11, 14],
        [lib.models.quiver, 6.5, -12, 14],
        [lib.models.trunk02, -7, -10, 14],
      ] as const;
      for (const [meshes, x, z, scale] of trunks)
        out.push(...place(meshes, [x, 0, z], rng() * 360, scale, TANNIN_WOOD));
      out.push(
        ...scatter(
          rng,
          lib.models.twigs,
          14,
          { x0: -4, x1: 4, z0: 1.2, z1: -5 },
          [3, 6],
          TANNIN_WOOD,
        ),
      );
      return out;
    },
  },
  'bg-blackwater-open-tannin': {
    camera: { position: [0, 1.2, 4], pitchDeg: 1, hfovDeg: 62, near: 0.3 },
    lighting: { ...BLACK_LIGHT, ambient: 0.75, toLight: [0.2, 0.95, 0.2] },
    focus: 9,
    palette: { ...TANNIN_WATER, veilDensity: 0.1, rayStrength: 0.2 },
    empty: [110, 70, 36],
    instances: (lib, cam) => {
      const rng = mulberry32(4905);
      return [
        floor(lib.litter, cam, TANNIN_LITTER, 1.6),
        ...scatter(
          rng,
          lib.models.twigs,
          10,
          { x0: -7, x1: 7, z0: -3, z1: -11 },
          [5, 8],
          TANNIN_WOOD,
        ),
        ...place(lib.models.quiver, [-5, 0, -13], 40, 12, TANNIN_WOOD),
        ...place(lib.models.trunk02, [6.5, 0, -14], 230, 12, TANNIN_WOOD),
      ];
    },
  },
  'bg-mangrove-prop-root-thicket': {
    camera: { position: [0, 0.8, 3.3], pitchDeg: 3, hfovDeg: 60, near: 0.3 },
    lighting: { ...MANGROVE_LIGHT, toLight: [-0.35, 0.85, 0.4] },
    focus: 4.5,
    palette: BRACKISH_WATER,
    empty: [90, 100, 60],
    instances: (lib, cam) => {
      const rng = mulberry32(5001);
      const out: Instance[] = [floor(lib.mud, cam, MUD_TINT, 1.5)];
      const flanks = [
        { x0: -4, x1: -0.9 },
        { x0: 0.9, x1: 4 },
      ];
      for (const flank of flanks)
        for (let i = 0; i < 9; i++)
          out.push(
            ...place(
              lib.models.propRoots,
              [flank.x0 + rng() * (flank.x1 - flank.x0), 0, -0.6 - rng() * 4.5],
              rng() * 360,
              7 + rng() * 5,
              ROOT_RED,
            ),
          );
      out.push(...place(lib.models.rootScan, [-2.2, -0.02, -1.1], 25, 3.4, ROOT_RED));
      out.push(...place(lib.models.rootScan, [2.4, -0.02, -1.3], 200, 3.2, ROOT_RED));
      out.push(
        ...scatter(
          rng,
          lib.models.propRoots,
          3,
          { x0: -0.8, x1: 0.8, z0: -6, z1: -9 },
          [8, 10],
          ROOT_RED,
        ),
      );
      return out;
    },
  },
  'bg-mangrove-red-roots': {
    camera: { position: [0, 0.6, 2.4], pitchDeg: 2, hfovDeg: 60, near: 0.25 },
    lighting: { ...MANGROVE_LIGHT, toLight: [-0.7, 0.7, 0.3] },
    focus: 3.4,
    palette: BRACKISH_WATER,
    empty: [90, 100, 60],
    instances: (lib, cam) => {
      const rng = mulberry32(5002);
      const out: Instance[] = [floor(lib.mud, cam, MUD_TINT, 1.4)];
      const spots: [number, number, number, number][] = [
        [-1.6, -2.2, 10, 3.4],
        [0.9, -2.6, 150, 3.2],
        [3.0, -3.2, 260, 3.4],
        [-3.6, -3.4, 60, 3.4],
        [-0.4, -4.6, 200, 3.6],
        [2.2, -5.4, 20, 3.6],
        [-2.6, -6, 120, 3.6],
        [5, -5, 300, 3.4],
      ];
      for (const [x, z, yaw, scale] of spots)
        out.push(...place(lib.models.rootScan, [x, -0.03, z], yaw, scale, ROOT_RED));
      out.push(
        ...scatter(
          rng,
          lib.models.rock,
          8,
          { x0: -3, x1: 3, z0: 1, z1: -2 },
          [1.5, 3],
          [0.8, 0.78, 0.7],
          0,
        ),
      );
      return out;
    },
  },
  'bg-mangrove-petrified-stump': {
    camera: { position: [0, 0.75, 3.3], pitchDeg: 3, hfovDeg: 60, near: 0.3 },
    lighting: { ...MANGROVE_LIGHT, toLight: [0.55, 0.8, 0.4] },
    focus: 4.2,
    palette: BRACKISH_WATER,
    empty: [90, 100, 60],
    instances: (lib, cam) => {
      const rng = mulberry32(5003);
      return [
        floor(lib.mud, cam, MUD_TINT, 1.5),
        ...place(lib.models.stump, [-1.5, -0.1, -1.4], 30, 7, [1, 0.96, 0.9]),
        ...place(lib.models.propRoots, [-3.4, 0, -3.2], 120, 9, ROOT_GREEN),
        ...place(lib.models.propRoots, [-0.2, 0, -4.4], 260, 10, ROOT_GREEN),
        ...place(lib.models.propRoots, [-2.4, 0, -5.4], 40, 9, ROOT_GREEN),
        ...scatter(
          rng,
          lib.models.rock,
          3,
          { x0: 1.5, x1: 3.5, z0: 0, z1: -2 },
          [2, 3.5],
          [0.7, 0.7, 0.62],
          0,
        ),
      ];
    },
  },
  'bg-mangrove-tidal-flat': {
    camera: { position: [0, 0.34, 3], pitchDeg: 3, hfovDeg: 64, near: 0.25 },
    lighting: { ...MANGROVE_LIGHT, ambient: 0.75, toLight: [-0.3, 0.9, 0.3] },
    focus: 3.4,
    palette: BRACKISH_WATER,
    empty: [90, 100, 60],
    instances: (lib, cam) => {
      const rng = mulberry32(5004);
      return [
        floor(lib.mudSand, cam, MUD_TINT, 2.2),
        ...scatter(
          rng,
          lib.models.propagule,
          28,
          { x0: -2.6, x1: 2.6, z0: 1.2, z1: -4 },
          [1.6, 2.6],
          ROOT_GREEN,
        ),
        ...place(lib.models.rootScan, [-4.6, -0.02, -10], 40, 2.2, ROOT_RED),
        ...place(lib.models.rootScan, [-1.4, -0.02, -12], 200, 2.2, ROOT_RED),
        ...place(lib.models.rootScan, [3.2, -0.02, -11], 120, 2.4, ROOT_RED),
        ...place(lib.models.rootScan, [7, -0.02, -13], 300, 2.4, ROOT_RED),
      ];
    },
  },
  'bg-mangrove-open-water': {
    camera: { position: [0, 1.2, 4], pitchDeg: 1, hfovDeg: 62, near: 0.3 },
    lighting: { ...MANGROVE_LIGHT, ambient: 0.75, toLight: [0.2, 0.95, 0.2] },
    focus: 9,
    palette: {
      ...BRACKISH_WATER,
      veilDensity: 0.14,
      rayStrength: 0.24,
      veilTop: [112, 128, 68],
      veilBottom: [22, 34, 18],
    },
    empty: [90, 100, 60],
    instances: (lib, cam) => {
      const rng = mulberry32(5005);
      const out: Instance[] = [floor(lib.mud, cam, MUD_TINT, 1.8)];
      for (let i = 0; i < 9; i++)
        out.push(
          ...place(
            lib.models.rootScan,
            [-9 + i * 2.3 + (rng() - 0.5), -0.02, -6.5 - rng() * 4],
            rng() * 360,
            1.8 + rng() * 0.8,
            ROOT_RED,
          ),
        );
      return out;
    },
  },
};

export function renderWaterScene(
  id: WaterBackgroundId,
  library: Library,
  width: number,
  shadowSize = 4096,
): Rendered {
  const scene = SCENES[id];
  return renderScene(
    {
      width,
      height: width / 2,
      camera: scene.camera,
      lighting: scene.lighting,
      instances: scene.instances(library, scene.camera),
      empty: scene.empty,
      far: DEPTH.far,
    },
    shadowSize,
  );
}

export async function renderWaterBackground(
  id: WaterBackgroundId,
  ctx: Pick<FishContext, 'verifySource'>,
  lib?: Library,
  width = WATER_WIDTH,
  outPath = waterRenderPath(id),
): Promise<string> {
  const height = width / 2;
  const scene = SCENES[id];
  const library = lib ?? (await loadLibrary(ctx));
  const { rgb, depth } = renderWaterScene(id, library, width);
  const depthRed = new Uint8Array(depth.length);
  for (let i = 0; i < depth.length; i++) {
    const t = ((depth[i] ?? 0) - DEPTH.near) / (DEPTH.far - DEPTH.near);
    depthRed[i] = Math.max(0, Math.min(255, Math.round(t * 255)));
  }
  const png = await developRender(
    rgb,
    depthRed,
    { ...DEPTH, focus: scene.focus },
    width,
    height,
    scene.palette,
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return outPath;
}

export async function renderAllWaterBackgrounds(
  ctx: Pick<FishContext, 'verifySource'>,
  only: readonly string[] = [],
  preview?: { width: number; dir: string },
): Promise<string[]> {
  const library = await loadLibrary(ctx);
  const ids = WATER_BACKGROUND_IDS.filter((id) => only.length === 0 || only.includes(id));
  const out: string[] = [];
  for (const id of ids)
    out.push(
      preview
        ? await renderWaterBackground(
            id,
            ctx,
            library,
            preview.width,
            join(preview.dir, `${id}.png`),
          )
        : await renderWaterBackground(id, ctx, library),
    );
  return out;
}
