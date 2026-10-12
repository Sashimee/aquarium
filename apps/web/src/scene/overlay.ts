import {
  BufferGeometry,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type { CapsuleCollider, Collider, HullCollider } from './colliders';

const TOLERANCE = 1e-5;

/** Corners of a plane-intersection polytope: every plane triple's point that no plane cuts off. */
export function hullVertices(hull: HullCollider): Vector3[] {
  const p = hull.planes;
  const n = Math.floor(p.length / 4);
  const normals: Vector3[] = [];
  for (let i = 0; i < n; i++) normals.push(new Vector3(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]));
  const seen = new Set<string>();
  const out: Vector3[] = [];
  const cross = new Vector3();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = normals[i];
        const b = normals[j];
        const c = normals[k];
        if (!a || !b || !c) continue;
        const det = a.dot(cross.crossVectors(b, c));
        if (Math.abs(det) < 1e-6) continue;
        const point = new Vector3()
          .addScaledVector(new Vector3().crossVectors(b, c), p[i * 4 + 3] ?? 0)
          .addScaledVector(new Vector3().crossVectors(c, a), p[j * 4 + 3] ?? 0)
          .addScaledVector(new Vector3().crossVectors(a, b), p[k * 4 + 3] ?? 0)
          .divideScalar(det);
        let inside = true;
        for (let m = 0; m < n && inside; m++) {
          inside = (normals[m]?.dot(point) ?? 0) <= (p[m * 4 + 3] ?? 0) + TOLERANCE;
        }
        const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
        if (inside && !seen.has(key)) {
          seen.add(key);
          out.push(point);
        }
      }
    }
  }
  return out;
}

function hullGeometry(hull: HullCollider): BufferGeometry {
  return new ConvexGeometry(hullVertices(hull));
}

function capsuleMesh(c: CapsuleCollider, material: MeshBasicNodeMaterial): Mesh {
  const a = new Vector3(...c.a);
  const b = new Vector3(...c.b);
  const axis = b.clone().sub(a);
  const length = axis.length();
  const mesh = new Mesh(new CapsuleGeometry(c.radius, Math.max(length, 1e-4), 4, 10), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  if (length > 1e-6) {
    mesh.quaternion.copy(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), axis.divideScalar(length)),
    );
  }
  return mesh;
}

/** Wireframes of the sim colliders, red for hard and green for soft, drawn over the scene. */
export class ColliderOverlay {
  readonly group = new Group();
  private readonly materials: MeshBasicNodeMaterial[] = [];

  constructor(colliders: readonly Collider[]) {
    this.group.name = 'collider-overlay';
    this.group.visible = false;
    this.group.renderOrder = 10;
    const hard = this.material(0xff4422);
    const soft = this.material(0x33dd55);
    for (const collider of colliders) {
      const material = collider.hard ? hard : soft;
      const mesh =
        collider.kind === 'capsule'
          ? capsuleMesh(collider, material)
          : new Mesh(hullGeometry(collider), material);
      mesh.renderOrder = 10;
      this.group.add(mesh);
    }
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  private material(color: number): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial({ color, wireframe: true });
    material.depthTest = false;
    material.transparent = true;
    material.fog = false;
    this.materials.push(material);
    return material;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    for (const material of this.materials) material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
