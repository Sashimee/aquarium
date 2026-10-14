import { describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry, type Mesh } from 'three/webgpu';
import { fitHull, type Collider } from './colliders';
import { ColliderOverlay, hullVertices } from './overlay';

describe('hullVertices', () => {
  it('spans the extent of the fitted point cloud', () => {
    const points: number[] = [];
    for (const x of [-0.1, 0.1]) {
      for (const y of [0, 0.2]) {
        for (const z of [-0.05, 0.05]) points.push(x, y, z);
      }
    }
    const vertices = hullVertices(fitHull(new Float64Array(points)));
    expect(vertices.length).toBeGreaterThanOrEqual(8);
    const xs = vertices.map((v) => v.x);
    const ys = vertices.map((v) => v.y);
    expect(Math.min(...xs)).toBeLessThanOrEqual(-0.1 + 1e-6);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(0.1 - 1e-6);
    expect(Math.min(...ys)).toBeLessThanOrEqual(1e-6);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(0.2 - 1e-6);
  });
});

describe('ColliderOverlay.setColliders', () => {
  const box = (x: number): Float64Array => {
    const points: number[] = [];
    for (const dx of [-0.05, 0.05]) {
      for (const y of [0, 0.1]) {
        for (const z of [-0.05, 0.05]) points.push(x + dx, y, z);
      }
    }
    return new Float64Array(points);
  };
  const capsule: Collider = {
    kind: 'capsule',
    hard: false,
    a: [0, 0, 0],
    b: [0, 0.2, 0],
    radius: 0.03,
  };

  it('redraws for a moved piece and frees the old wireframes', () => {
    const overlay = new ColliderOverlay([fitHull(box(-0.2)), capsule]);
    const freed = new Set<BufferGeometry>();
    for (const child of overlay.group.children) {
      const geometry = (child as Mesh).geometry;
      geometry.addEventListener('dispose', () => freed.add(geometry));
    }

    overlay.setColliders([fitHull(box(0.2)), capsule]);

    expect(overlay.group.children).toHaveLength(2);
    expect(freed.size).toBe(2);
    const moved = new Box3().setFromObject(overlay.group.children[0] as Mesh);
    expect(moved.min.x).toBeCloseTo(0.15, 3);
    overlay.dispose();
  });

  it('keeps its visibility and draws nothing for an empty list', () => {
    const overlay = new ColliderOverlay([capsule]);
    overlay.visible = true;
    overlay.setColliders([]);
    expect(overlay.group.children).toHaveLength(0);
    expect(overlay.visible).toBe(true);
    overlay.dispose();
  });
});
