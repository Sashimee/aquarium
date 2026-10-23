import { compileCollider } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import { collidersFor } from './colliders';
import { item, must, spec } from './fixtures';

const normal = new Float64Array(3);
const sdf = (c: ReturnType<typeof collidersFor>[number], x: number, y: number, z: number) =>
  compileCollider(c).sample(x, y, z, normal);

describe('collidersFor', () => {
  it('gives a rock one hard rounded box carrying the piece id', () => {
    const [collider, ...rest] = collidersFor(
      'p3',
      spec('boulder-01'),
      item('boulder-01', 0.2, 0.1),
    );
    expect(rest).toEqual([]);
    expect(collider).toMatchObject({ id: 'decor:p3', hard: true, kind: 'box' });
  });

  it('is solid inside the piece and clear outside it', () => {
    const c = must(collidersFor('p1', spec('boulder-01'), item('boulder-01', 0, 0))[0]);
    expect(sdf(c, 0, 0.06 + 0.08, 0)).toBeLessThan(0);
    expect(sdf(c, 0.4, 0.14, 0)).toBeGreaterThan(0.1);
  });

  it('follows the piece when it is moved', () => {
    const before = must(collidersFor('p1', spec('boulder-01'), item('boulder-01', 0, 0))[0]);
    const after = must(collidersFor('p1', spec('boulder-01'), item('boulder-01', 0.4, 0))[0]);
    const probe: [number, number, number] = [0.4, 0.14, 0];
    expect(sdf(before, ...probe)).toBeGreaterThan(0.1);
    expect(sdf(after, ...probe)).toBeLessThan(0);
  });

  it('turns with the piece', () => {
    const f = (rotationY: number) =>
      must(collidersFor('p1', spec('boulder-01'), item('boulder-01', 0, 0, { rotationY }))[0]);
    const probe: [number, number, number] = [0, 0.14, 0.16];
    expect(sdf(f(0), ...probe)).toBeLessThan(0);
    expect(sdf(f(Math.PI / 2), ...probe)).toBeGreaterThan(0);
  });

  it('lets a fish pass under the raised end of lying driftwood', () => {
    const c = must(
      collidersFor('p1', spec('dead-tree-trunk-02'), item('dead-tree-trunk-02', 0, 0))[0],
    );
    expect(c.kind).toBe('capsule');
    expect(sdf(c, 0, 0.06 + 0.07, 0)).toBeLessThan(0);
    expect(sdf(c, 0, 0.06 + 0.3, 0)).toBeGreaterThan(0.1);
  });

  it('makes upright driftwood a tall capsule', () => {
    const c = must(
      collidersFor('p1', spec('dead-quiver-trunk'), item('dead-quiver-trunk', 0, 0))[0],
    );
    expect(c.kind).toBe('capsule');
    expect(sdf(c, 0, 0.06 + 0.4, 0)).toBeLessThan(0);
  });

  it('scales the collider with the piece', () => {
    const small = must(collidersFor('p1', spec('boulder-01'), item('boulder-01', 0, 0))[0]);
    const big = must(
      collidersFor('p1', spec('boulder-01'), item('boulder-01', 0, 0, { scale: 2 }))[0],
    );
    const probe: [number, number, number] = [0.2, 0.2, 0];
    expect(sdf(small, ...probe)).toBeGreaterThan(0);
    expect(sdf(big, ...probe)).toBeLessThan(0);
  });

  it('has a collider for the vacation feeder too', () => {
    const feeder = spec('vacation-feeder');
    expect(collidersFor('p9', feeder, item('vacation-feeder', 0, 0))).toHaveLength(1);
  });

  it('has none for a flat catappa leaf card lying on the sand', () => {
    expect(collidersFor('p7', spec('catappa-leaf-card'), item('catappa-leaf-card', 0, 0))).toEqual(
      [],
    );
  });
});

describe('plant colliders', () => {
  const fern = spec('java-fern');

  it('is a soft capsule matching the scene proxy', () => {
    const [collider, ...rest] = collidersFor('p2', fern, item('java-fern', 0.1, 0.2, { scale: 2 }));
    expect(rest).toEqual([]);
    expect(collider).toEqual({
      id: 'decor:p2',
      hard: false,
      kind: 'capsule',
      a: [0.1, 0.06 + 0.15, 0.2],
      b: [0.1, 0.06 + 0.187478 * 2 * 0.8, 0.2],
      radius: 0.15,
    });
  });

  it('floors the radius at 4 cm', () => {
    const [collider] = collidersFor('p1', spec('water-plant'), item('water-plant', 0, 0));
    expect(collider).toMatchObject({ kind: 'capsule', radius: 0.04 });
  });

  it('has none for a plant under 15 cm tall', () => {
    expect(collidersFor('p1', spec('staurogyne-repens'), item('staurogyne-repens', 0, 0))).toEqual(
      [],
    );
  });
});
