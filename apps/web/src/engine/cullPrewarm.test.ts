import { DirectionalLight, Group, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CullPrewarm } from './cullPrewarm';

function scene() {
  const root = new Group();
  const plant = new Mesh(undefined, new MeshBasicNodeMaterial());
  const rock = new Mesh(undefined, new MeshBasicNodeMaterial());
  root.add(plant, rock);
  return { root, plant, rock };
}

describe('CullPrewarm', () => {
  it('draws every new object unculled for one frame, then restores culling', () => {
    const { root, plant, rock } = scene();
    const warm = new CullPrewarm(root);
    expect(warm.begin(0)).toBe(3);
    expect(plant.frustumCulled).toBe(false);
    expect(rock.frustumCulled).toBe(false);
    warm.end();
    expect(plant.frustumCulled).toBe(true);
    expect(rock.frustumCulled).toBe(true);
    expect(warm.begin(1000)).toBe(0);
  });

  it('only rescans after the interval and then warms just the objects added since', () => {
    const { root, plant } = scene();
    const warm = new CullPrewarm(root, 500);
    warm.begin(0);
    warm.end();
    const added = new Mesh();
    root.add(added);
    expect(warm.begin(499)).toBe(0);
    expect(added.frustumCulled).toBe(true);
    expect(warm.begin(500)).toBe(1);
    expect(added.frustumCulled).toBe(false);
    expect(plant.frustumCulled).toBe(true);
    warm.end();
    expect(added.frustumCulled).toBe(true);
  });

  it('waits for hidden objects to become visible', () => {
    const { root, rock } = scene();
    rock.visible = false;
    const warm = new CullPrewarm(root, 0);
    expect(warm.begin(0)).toBe(2);
    warm.end();
    rock.visible = true;
    expect(warm.begin(1)).toBe(1);
    expect(rock.frustumCulled).toBe(false);
    warm.end();
  });

  it('leaves objects that never cull alone', () => {
    const { root, plant } = scene();
    plant.frustumCulled = false;
    const warm = new CullPrewarm(root);
    warm.begin(0);
    warm.end();
    expect(plant.frustumCulled).toBe(false);
  });

  it('warms an object again once its material is flagged for update or swapped', () => {
    const { root, plant, rock } = scene();
    const warm = new CullPrewarm(root, 0);
    warm.begin(0);
    warm.end();

    rock.material.needsUpdate = true;
    expect(warm.begin(1)).toBe(1);
    expect(rock.frustumCulled).toBe(false);
    expect(plant.frustumCulled).toBe(true);
    warm.end();
    expect(warm.begin(2)).toBe(0);

    plant.material = new MeshBasicNodeMaterial();
    expect(warm.begin(3)).toBe(1);
    expect(plant.frustumCulled).toBe(false);
    warm.end();
  });

  it('warms a multi-material object when any of its materials changes', () => {
    const root = new Group();
    const a = new MeshBasicNodeMaterial();
    const b = new MeshBasicNodeMaterial();
    const mesh = new Mesh(undefined, [a, b]);
    root.add(mesh);
    const warm = new CullPrewarm(root, 0);
    warm.begin(0);
    warm.end();
    b.needsUpdate = true;
    expect(warm.begin(1)).toBe(1);
    warm.end();
  });

  it('warms everything again when a light joins, since every lit pipeline changes', () => {
    const { root, plant, rock } = scene();
    const warm = new CullPrewarm(root, 0);
    warm.begin(0);
    warm.end();
    root.add(new DirectionalLight());
    expect(warm.begin(1)).toBe(4);
    expect(plant.frustumCulled).toBe(false);
    expect(rock.frustumCulled).toBe(false);
    warm.end();
    expect(warm.begin(2)).toBe(0);
  });

  it('warms everything again after invalidate(), without waiting for the interval', () => {
    const { root, rock } = scene();
    const warm = new CullPrewarm(root, 500);
    warm.begin(0);
    warm.end();
    warm.invalidate();
    expect(warm.begin(1)).toBe(3);
    expect(rock.frustumCulled).toBe(false);
    warm.end();
  });

  it('rejects a nested begin and a negative interval', () => {
    const warm = new CullPrewarm(scene().root);
    warm.begin(0);
    expect(() => warm.begin(1000)).toThrow(/without end/);
    expect(() => new CullPrewarm(new Group(), -1)).toThrow(RangeError);
  });
});
