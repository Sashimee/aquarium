import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mulberry32 } from './anemone.ts';
import { loadEnvironment, sceneBaseColor } from './environment.ts';
import type { FishContext } from './fish.ts';
import { developRender, type DepthParams } from './misty-lake.ts';
import type { MaterialDef } from './parts.ts';
import { ENVIRONMENT_RECIPES } from './recipes.ts';
import {
  buildMips,
  groundMesh,
  renderScene,
  type Instance,
  type MipTexture,
  type SceneMesh,
  type SceneSpec,
} from './soft-render.ts';
import { RAW_ROOT } from './source.ts';
import { decodeImage, resizeImage } from './textures.ts';

export const CICHLID_WIDTH = 4096;
export const CICHLID_BACKGROUND_IDS = [
  'bg-cichlid-malawi-rock-pile',
  'bg-cichlid-rock-wall',
  'bg-cichlid-tanganyika-shell-bed',
  'bg-cichlid-rock-cave',
  'bg-cichlid-open-blue',
] as const;
export type CichlidBackgroundId = (typeof CICHLID_BACKGROUND_IDS)[number];

export function cichlidRenderPath(id: string): string {
  return join(RAW_ROOT, id, 'render.png');
}

const DEPTH: DepthParams = { near: 1.5, far: 22, focus: 4.5 };

type Vec3 = readonly [number, number, number];

const SAND_RAW = 'polyhaven-coast_sand_04/coast_sand_04_diff_2k.jpg';

interface Library {
  rocks: Record<'boulder03' | 'boulder05' | 'rock07' | 'boulder01' | 'shell', SceneMesh[]>;
  sand: MipTexture;
}

const GREY_TEXEL: MipTexture = buildMips({
  width: 1,
  height: 1,
  data: Uint8Array.from([128, 128, 128, 255]),
});

async function loadMeshes(
  recipeId: string,
  ctx: Pick<FishContext, 'verifySource'>,
): Promise<SceneMesh[]> {
  const recipe = ENVIRONMENT_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`no environment recipe ${recipeId}`);
  const { parts, materials } = await loadEnvironment(recipe, ctx);
  const byName = new Map<string, MaterialDef>(materials.map((m) => [m.name, m]));
  const textures = new Map<string, MipTexture>();
  return parts.map((part) => {
    const material = byName.get(part.material);
    let texture = textures.get(part.material);
    if (!texture) {
      const baseColor = sceneBaseColor(material, part.material, recipe.id);
      texture = baseColor ? buildMips(baseColor.image) : GREY_TEXEL;
      textures.set(part.material, texture);
    }
    const factor = material?.baseColorFactor ?? [1, 1, 1, 1];
    return {
      positions: part.positions,
      normals: part.normals,
      uvs: part.uvs,
      indices: part.indices,
      texture,
      tint: [factor[0], factor[1], factor[2]] as const,
      castsShadow: true,
    };
  });
}

async function loadGround(file: string): Promise<MipTexture> {
  const path = join(RAW_ROOT, file);
  if (!existsSync(path)) throw new Error(`${path} is missing; run the asset downloads first`);
  return buildMips(await resizeImage(await decodeImage(readFileSync(path)), 1024));
}

async function loadLibrary(ctx: Pick<FishContext, 'verifySource'>): Promise<Library> {
  return {
    rocks: {
      boulder03: await loadMeshes('malawi-boulder-03', ctx),
      boulder05: await loadMeshes('malawi-boulder-05', ctx),
      rock07: await loadMeshes('malawi-rock-07', ctx),
      boulder01: await loadMeshes('boulder-01', ctx),
      shell: await loadMeshes('neothauma-shell', ctx),
    },
    sand: await loadGround(SAND_RAW),
  };
}

function place(meshes: SceneMesh[], position: Vec3, yawDeg: number, scale: number): Instance[] {
  return meshes.map((mesh) => ({ mesh, position, yawDeg, scale }));
}

interface SceneBuilder {
  camera: SceneSpec['camera'];
  lighting: SceneSpec['lighting'];
  focus: number;
  instances: (lib: Library) => Instance[];
}

const CAMERA = { position: [0, 0.7, 3.2] as Vec3, pitchDeg: 4, hfovDeg: 60, near: 0.3 };
const LIGHT = { ambient: 0.75, diffuse: 0.85, shadowStrength: 0.7 };

function floor(texture: MipTexture, camera: SceneSpec['camera']): Instance {
  return {
    mesh: groundMesh({
      halfWidth: 70,
      zNear: camera.position[2] - 0.4,
      zFar: -45,
      tile: 1.6,
      texture,
      steps: 160,
    }),
    position: [0, 0, 0],
    yawDeg: 0,
    scale: 1,
  };
}

const SCENES: Record<CichlidBackgroundId, SceneBuilder> = {
  'bg-cichlid-malawi-rock-pile': {
    camera: CAMERA,
    lighting: { ...LIGHT, toLight: [-0.35, 0.85, 0.4] },
    focus: 4.5,
    instances: (lib) => [
      floor(lib.sand, CAMERA),
      ...place(lib.rocks.boulder03, [-1.0, 0, -1.2], 25, 5.5),
      ...place(lib.rocks.boulder05, [0.25, 0, -0.9], 200, 5),
      ...place(lib.rocks.rock07, [-1.0, 0.8, -1.2], 40, 5),
      ...place(lib.rocks.boulder01, [-3, 0, -2.2], 70, 4.5),
      ...place(lib.rocks.rock07, [-0.3, 0, 0.5], 10, 3),
      ...place(lib.rocks.rock07, [0.9, 0, 0.2], 120, 2.5),
      ...place(lib.rocks.rock07, [-2.3, 0, 0.2], 300, 3.4),
      ...place(lib.rocks.rock07, [-1.9, 0, 0.9], 60, 2),
    ],
  },
  'bg-cichlid-rock-wall': {
    camera: { ...CAMERA, position: [0, 0.8, 3], pitchDeg: 3 },
    lighting: { ...LIGHT, toLight: [0.45, 0.8, 0.4] },
    focus: 4,
    instances: (lib) => {
      const cam = { ...CAMERA, position: [0, 0.8, 3] as Vec3 };
      const out: Instance[] = [floor(lib.sand, cam)];
      const rng = mulberry32(48);
      const flanks = [
        { x0: -3.6, x1: -1.0, z: -1.2 },
        { x0: 1.0, x1: 3.6, z: -1.4 },
      ];
      for (const flank of flanks) {
        for (let layer = 0; layer < 3; layer++) {
          for (let x = flank.x0; x < flank.x1; x += 1.0) {
            const pick = rng();
            const meshes =
              pick < 0.4
                ? lib.rocks.boulder03
                : pick < 0.75
                  ? lib.rocks.boulder05
                  : lib.rocks.rock07;
            const scale = (pick < 0.4 ? 5.5 : pick < 0.75 ? 5 : 6) * (0.85 + 0.3 * rng());
            out.push(
              ...place(
                meshes,
                [x + (rng() - 0.5) * 0.3, layer * 0.5 - 0.05, flank.z - layer * 0.25 + rng() * 0.2],
                rng() * 360,
                scale,
              ),
            );
          }
        }
      }
      out.push(...place(lib.rocks.boulder01, [-0.2, 0, -3.2], 20, 6));
      out.push(...place(lib.rocks.rock07, [0.3, 0, -1.8], 140, 4));
      return out;
    },
  },
  'bg-cichlid-tanganyika-shell-bed': {
    camera: { position: [0, 0.5, 2.3], pitchDeg: 14, hfovDeg: 62, near: 0.2 },
    lighting: { ...LIGHT, toLight: [-0.3, 0.9, 0.35] },
    focus: 2.6,
    instances: (lib) => {
      const cam = { position: [0, 0.5, 2.3] as Vec3, pitchDeg: 14, hfovDeg: 62, near: 0.2 };
      const out: Instance[] = [floor(lib.sand, cam)];
      const rng = mulberry32(1432);
      for (let i = 0; i < 48; i++) {
        const z = 1.2 - 4.2 * Math.pow(rng(), 0.8);
        const x = (rng() - 0.5) * (2.2 + Math.abs(z) * 0.9);
        out.push(...place(lib.rocks.shell, [x, -0.004, z], rng() * 360, 2.2 + rng() * 1.2));
      }
      out.push(...place(lib.rocks.rock07, [-0.9, 0, -1.7], 30, 4));
      out.push(...place(lib.rocks.rock07, [1.1, 0, -2.8], 200, 5));
      out.push(...place(lib.rocks.boulder05, [0.1, 0, -5], 80, 6));
      return out;
    },
  },
  'bg-cichlid-rock-cave': {
    camera: { ...CAMERA, position: [0, 0.6, 3.4], pitchDeg: 4 },
    lighting: { ambient: 0.5, diffuse: 0.95, shadowStrength: 0.9, toLight: [-0.8, 0.5, 0.35] },
    focus: 4.4,
    instances: (lib) => {
      const cam = { ...CAMERA, position: [0, 0.6, 3.4] as Vec3 };
      return [
        floor(lib.sand, cam),
        ...place(lib.rocks.boulder03, [-1.0, 0, -1.4], 85, 6),
        ...place(lib.rocks.boulder05, [1.0, 0, -1.4], 250, 6.5),
        ...place(lib.rocks.boulder03, [0.0, 0.62, -1.5], 10, 5.8),
        ...place(lib.rocks.boulder05, [-0.2, 0, -3.4], 150, 7),
        ...place(lib.rocks.rock07, [2.4, 0, -0.2], 60, 4),
        ...place(lib.rocks.rock07, [-2.4, 0, -0.1], 330, 3.5),
      ];
    },
  },
  'bg-cichlid-open-blue': {
    camera: { position: [0, 1.2, 4], pitchDeg: 1, hfovDeg: 62, near: 0.3 },
    lighting: { ...LIGHT, ambient: 1, toLight: [0.2, 0.95, 0.2] },
    focus: 9,
    instances: (lib) => {
      const cam = { position: [0, 1.2, 4] as Vec3, pitchDeg: 1, hfovDeg: 62, near: 0.3 };
      return [
        floor(lib.sand, cam),
        ...place(lib.rocks.boulder03, [-4.2, -0.1, -6], 30, 9),
        ...place(lib.rocks.boulder05, [-1.2, -0.1, -7], 120, 10),
        ...place(lib.rocks.boulder03, [2.2, -0.1, -6.5], 250, 8.5),
        ...place(lib.rocks.boulder05, [5, -0.1, -5.5], 70, 8),
        ...place(lib.rocks.rock07, [0.5, 0, -4.5], 10, 7),
        ...place(lib.rocks.boulder01, [-6.5, -0.1, -5], 200, 7),
      ];
    },
  },
};

export async function renderCichlidBackground(
  id: CichlidBackgroundId,
  ctx: Pick<FishContext, 'verifySource'>,
  lib?: Library,
  width = CICHLID_WIDTH,
  outPath = cichlidRenderPath(id),
): Promise<string> {
  const height = width / 2;
  const scene = SCENES[id];
  const library = lib ?? (await loadLibrary(ctx));
  const { rgb, depth } = renderScene({
    width,
    height,
    camera: scene.camera,
    lighting: scene.lighting,
    instances: scene.instances(library),
    empty: [70, 120, 140],
    far: DEPTH.far,
  });
  const depthRed = new Uint8Array(depth.length);
  for (let i = 0; i < depth.length; i++) {
    const t = ((depth[i] ?? 0) - DEPTH.near) / (DEPTH.far - DEPTH.near);
    depthRed[i] = Math.max(0, Math.min(255, Math.round(t * 255)));
  }
  const png = await developRender(rgb, depthRed, { ...DEPTH, focus: scene.focus }, width, height);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return outPath;
}

export async function renderAllCichlidBackgrounds(
  ctx: Pick<FishContext, 'verifySource'>,
  only: readonly string[] = [],
): Promise<string[]> {
  const library = await loadLibrary(ctx);
  const ids = CICHLID_BACKGROUND_IDS.filter((id) => only.length === 0 || only.includes(id));
  const out: string[] = [];
  for (const id of ids) out.push(await renderCichlidBackground(id, ctx, library));
  return out;
}
