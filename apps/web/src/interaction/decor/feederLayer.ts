import { BoxGeometry, Group, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import type { DecorItem } from '@aquarium/shared';
import type { Piece } from './layout';
import { FEEDER_SPEC } from './spec';

const SIZE = FEEDER_SPEC.box;
const LIFT = (SIZE.max[1] - SIZE.min[1]) / 2;

/** The vacation feeders' meshes. It lives in the main bundle so the lazy decor chunks need no three.js of their own. */
export class FeederLayer {
  readonly group = new Group();
  private readonly meshes = new Map<string, Mesh>();
  private readonly geometry = new BoxGeometry(
    SIZE.max[0] - SIZE.min[0],
    SIZE.max[1] - SIZE.min[1],
    SIZE.max[2] - SIZE.min[2],
  );
  private readonly material = new MeshStandardNodeMaterial({
    color: 0xe8e4d8,
    roughness: 0.6,
    transparent: true,
    opacity: 0.92,
  });

  constructor() {
    this.group.name = 'decor-extras';
  }

  get count(): number {
    return this.meshes.size;
  }

  sync(feeders: readonly Piece[]): void {
    const wanted = new Map(feeders.map((p) => [p.id, p]));
    for (const [id, mesh] of this.meshes) {
      if (wanted.has(id)) continue;
      mesh.removeFromParent();
      this.meshes.delete(id);
    }
    for (const [id, piece] of wanted) {
      let mesh = this.meshes.get(id);
      if (!mesh) {
        mesh = new Mesh(this.geometry, this.material);
        mesh.name = 'vacation-feeder';
        mesh.castShadow = true;
        this.meshes.set(id, mesh);
        this.group.add(mesh);
      }
      this.place(mesh, piece.item);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.meshes.clear();
  }

  private place(mesh: Mesh, item: DecorItem): void {
    mesh.position.set(item.position[0], item.position[1] + LIFT * item.scale, item.position[2]);
    mesh.rotation.y = item.rotationY;
    mesh.scale.setScalar(item.scale);
  }
}
