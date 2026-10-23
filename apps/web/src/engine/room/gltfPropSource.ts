import {
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Material,
  type Mesh,
  type Object3D,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ASSET_BASE } from '../../scene/assets';
import type { PropSource } from '../../scene/room/RoomProps';
import type { PropLod } from '../../scene/room/roomScene';
import { gltfKtx2Loader, type Ktx2Textures } from '../ktx2';

/** The GLB of a prop at a LOD, relative to the assets root, from `assets/index.json`. */
export type PropFiles = (asset: string, lod: PropLod) => string;

export function propFilesFrom(
  entries: Iterable<{ id: string; kind: string; lods: readonly { file: string }[] }>,
): PropFiles {
  const byId = new Map<string, readonly { file: string }[]>();
  for (const entry of entries) {
    if (entry.kind === 'room-furniture') byId.set(entry.id, entry.lods);
  }
  return (asset, lod) => {
    const lods = byId.get(asset);
    if (!lods)
      throw new Error(
        `Unknown room prop "${asset}"; check content/rooms.json against assets/index.json`,
      );
    const file = lods[lod]?.file;
    if (!file) throw new Error(`Room prop "${asset}" has no LOD ${lod} in assets/index.json`);
    return file;
  };
}

/** What the node twin leaves out of `source`, which RoomLight's lighting has no place for. */
function droppedMaterialFeatures(source: MeshStandardMaterial): string[] {
  const dropped: string[] = [];
  if (source instanceof MeshPhysicalMaterial && source.transmission > 0) {
    dropped.push('transmission (glass)');
  }
  if (source.envMapIntensity !== 1) dropped.push('envMapIntensity');
  if (source.alphaHash) dropped.push('alphaHash');
  return dropped;
}

/**
 * The node twin of a glTF material, named `room-prop-…` so `RoomLight` lights it with the room.
 * The source material is freed; its textures move to the twin.
 */
export function roomPropMaterial(source: Material): MeshStandardNodeMaterial {
  if (!(source instanceof MeshStandardMaterial)) {
    throw new Error(
      `Room prop material "${source.name}" is ${source.type}, expected a glTF PBR material`,
    );
  }
  const dropped = droppedMaterialFeatures(source);
  if (dropped.length > 0) {
    console.debug(`Room prop material "${source.name}" drops ${dropped.join(', ')}`);
  }
  const material = new MeshStandardNodeMaterial();
  material.name = `room-prop-${source.name || 'material'}`;
  material.color.copy(source.color);
  material.roughness = source.roughness;
  material.metalness = source.metalness;
  material.map = source.map;
  material.normalMap = source.normalMap;
  material.normalMapType = source.normalMapType;
  material.normalScale.copy(source.normalScale);
  material.roughnessMap = source.roughnessMap;
  material.metalnessMap = source.metalnessMap;
  material.aoMap = source.aoMap;
  material.aoMapIntensity = source.aoMapIntensity;
  material.emissive.copy(source.emissive);
  material.emissiveMap = source.emissiveMap;
  material.emissiveIntensity = source.emissiveIntensity;
  material.alphaMap = source.alphaMap;
  material.opacity = source.opacity;
  material.transparent = source.transparent;
  material.alphaTest = source.alphaTest;
  material.side = source.side;
  material.vertexColors = source.vertexColors;
  material.depthWrite = source.depthWrite;
  source.dispose();
  return material;
}

/** Room furniture as the GLBs the asset pipeline writes, through the engine's one transcoder. */
export class GltfPropSource implements PropSource {
  private readonly loader: GLTFLoader;

  constructor(
    ktx2: Ktx2Textures,
    private readonly files: PropFiles,
  ) {
    this.loader = new GLTFLoader().setKTX2Loader(gltfKtx2Loader(ktx2));
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async load(asset: string, lod: PropLod, signal?: AbortSignal): Promise<Object3D> {
    const url = `${ASSET_BASE}${this.files(asset, lod)}`;
    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) throw new Error(`Room prop ${url} returned HTTP ${response.status}`);
    const glb = await response.arrayBuffer();
    signal?.throwIfAborted();
    const gltf = await this.loader.parseAsync(glb, url.slice(0, url.lastIndexOf('/') + 1));
    const twins = new Map<Material, MeshStandardNodeMaterial>();
    gltf.scene.traverse((object) => {
      const mesh = object as Partial<Mesh>;
      if (!mesh.isMesh || !mesh.material) return;
      const swap = (m: Material) => {
        let twin = twins.get(m);
        if (!twin) {
          twin = roomPropMaterial(m);
          twins.set(m, twin);
        }
        return twin;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    return gltf.scene;
  }
}
