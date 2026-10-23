import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PointLight,
  Quaternion,
  Vector3,
  Color,
  type BufferGeometry,
  type Material,
  type Texture,
  type Object3D,
} from 'three/webgpu';
import { raceAbort } from '../abortable';
import type { PlacedProp, PropLod, RoomScenePlan } from './roomScene';

export interface PropSource {
  /** One loaded copy of a prop at a LOD; the room instances it for every placement. */
  load(asset: string, lod: PropLod, signal?: AbortSignal): Promise<Object3D>;
}

const UP = new Vector3(0, 1, 0);

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if ((value as Partial<Texture> | null)?.isTexture) (value as Texture).dispose();
  }
  material.dispose();
}

/**
 * The furniture and lamps of one room. A prop placed several times is one instanced draw per
 * primitive, so four bar chairs cost what one does. Lamp glass is blended and so draws after the
 * opaque props without any ordering here.
 */
export class RoomProps {
  readonly group = new Group();
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private generation = 0;

  constructor() {
    this.group.name = 'room-props';
  }

  get drawCalls(): number {
    let calls = 0;
    this.group.traverse((o) => {
      if ((o as Partial<Mesh>).isMesh) calls++;
    });
    return calls;
  }

  async show(plan: RoomScenePlan, source: PropSource, signal?: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    this.clear();
    const byAsset = new Map<string, PlacedProp[]>();
    for (const prop of plan.props) {
      const list = byAsset.get(prop.asset);
      if (list) list.push(prop);
      else byAsset.set(prop.asset, [prop]);
    }
    const wanted = [...byAsset];
    const attempts = wanted.map(async ([asset, placements]) => {
      const first = placements[0];
      if (!first) throw new Error(`room props: no placement for ${asset}`);
      return source.load(asset, first.lod, signal);
    });
    let roots: Object3D[];
    try {
      const all = Promise.all(attempts);
      roots = await (signal ? raceAbort(all, signal) : all);
    } catch (cause) {
      for (const attempt of attempts) {
        attempt.then(
          (late) => this.release(late),
          (late: unknown) => {
            if (!isAbort(late)) console.debug(`A ${plan.roomId} room prop load failed`, late);
          },
        );
      }
      if (generation !== this.generation) return;
      throw cause;
    }
    if (generation !== this.generation) {
      for (const root of roots) this.release(root);
      return;
    }
    const loaded = wanted.map(([asset, placements], i) => ({
      asset,
      placements,
      root: roots[i] as Object3D,
    }));
    for (const { asset, placements, root } of loaded) this.instance(asset, placements, root);
    for (const lamp of plan.light.practical) {
      const light = new PointLight(new Color(lamp.color), lamp.intensity, lamp.distance, 2);
      light.name = `room-lamp-${lamp.asset}`;
      light.position.set(...lamp.position);
      this.group.add(light);
    }
  }

  dispose(): void {
    this.generation++;
    this.clear();
    this.group.removeFromParent();
  }

  private instance(asset: string, placements: readonly PlacedProp[], root: Object3D): void {
    root.updateMatrixWorld(true);
    const spin = new Quaternion();
    const place = new Matrix4();
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      if ((o as Partial<Mesh>).isMesh) meshes.push(o as Mesh);
    });
    for (const mesh of meshes) {
      const instanced = new InstancedMesh(mesh.geometry, mesh.material, placements.length);
      instanced.name = `room-prop-${asset}`;
      placements.forEach((p, i) => {
        spin.setFromAxisAngle(UP, p.rotationY);
        place.compose(new Vector3(...p.position), spin, new Vector3(p.scale, p.scale, p.scale));
        instanced.setMatrixAt(i, place.multiply(mesh.matrixWorld));
      });
      instanced.instanceMatrix.needsUpdate = true;
      this.group.add(instanced);
      this.geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        this.materials.add(material);
      }
    }
  }

  private release(root: Object3D): void {
    root.traverse((o) => {
      const mesh = o as Partial<Mesh>;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m) disposeMaterial(m);
      }
    });
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      if ((child as Partial<InstancedMesh>).isInstancedMesh) (child as InstancedMesh).dispose();
    }
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) disposeMaterial(material);
    this.geometries.clear();
    this.materials.clear();
  }
}
