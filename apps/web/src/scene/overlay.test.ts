import { describe, expect, it } from 'vitest';
import { fitHull } from './colliders';
import { hullVertices } from './overlay';

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
