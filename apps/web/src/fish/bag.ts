import {
  DoubleSide,
  LatheGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Vector2,
  type Group,
} from 'three/webgpu';
import { abs, dot, normalView, positionViewDirection, pow, vec3 } from 'three/tsl';

/** Thin polythene: almost clear face-on, a sheen at grazing angles (Schlick, F0 of PE ≈ 0.04). */
function createBagMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0 });
  material.name = 'acclimation-bag';
  material.colorNode = vec3(0.92, 0.95, 0.97);
  const cosTheta = abs(dot(normalView, positionViewDirection)).clamp(0, 1);
  material.opacityNode = pow(cosTheta.oneMinus(), 5).mul(0.9).add(0.07);
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  return material;
}

/** A unit-radius bag from the rounded bottom up to the knotted neck above the water. */
function createBagGeometry(): LatheGeometry {
  const profile = [
    [0, -1],
    [0.55, -0.9],
    [0.9, -0.55],
    [1, 0],
    [0.85, 0.5],
    [0.45, 0.95],
    [0.14, 1.2],
    [0.2, 1.32],
    [0.06, 1.45],
    [0, 1.46],
  ].map(([x, y]) => new Vector2(x, y));
  return new LatheGeometry(profile, 24);
}

/** One floating bag per acclimating fish, kept in step with the fish each frame. */
export class AcclimationBags {
  private readonly geometry = createBagGeometry();
  private readonly material = createBagMaterial();
  private readonly meshes = new Map<string, Mesh>();
  private readonly placed = new Set<string>();

  constructor(private readonly parent: Group) {}

  begin(): void {
    this.placed.clear();
  }

  place(key: string, x: number, y: number, z: number, radius: number): void {
    let mesh = this.meshes.get(key);
    if (mesh === undefined) {
      mesh = new Mesh(this.geometry, this.material);
      mesh.name = 'acclimation-bag';
      mesh.renderOrder = 1;
      this.meshes.set(key, mesh);
      this.parent.add(mesh);
    }
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(radius);
    this.placed.add(key);
  }

  /** Removes the bags not placed since `begin`. */
  end(): void {
    for (const [key, mesh] of this.meshes) {
      if (this.placed.has(key)) continue;
      mesh.removeFromParent();
      this.meshes.delete(key);
    }
  }

  get count(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.meshes.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
