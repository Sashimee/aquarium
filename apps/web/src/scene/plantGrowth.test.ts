import type { DecorItem, Plant } from '@aquarium/shared';
import { Matrix4, Ray, Vector3 } from 'three';
import { BoxGeometry, InstancedMesh, MeshStandardMaterial } from 'three/webgpu';
import { FlowField, type FlowBounds } from '@aquarium/sim';
import { describe, expect, it } from 'vitest';
import type { LoadedModel } from './assets';
import { CurrentField } from './current';
import { ROOT_DEPTH } from './placement';
import {
  grownItem,
  layoutPlantKeys,
  offsetEntries,
  offsetEntry,
  pickablePlants,
  pickPlant,
  type GrowthContext,
  type LayoutPlantRef,
} from './plantGrowth';
import { PlantGroup } from './plants';
import { offsetCapacity } from './TankScene';

const WATER_TOP = 0.5;

function item(seed: number, x = 0, scale = 1): DecorItem {
  return {
    assetId: 'water-plant',
    position: [x, 0.05, 0.1],
    rotationY: 0.3,
    scale,
    tintSeed: seed,
  };
}

function ref(seed: number, x = 0, scale = 1): LayoutPlantRef {
  return { key: `s${seed}`, item: item(seed, x, scale), height: 0.2, halfWidth: 0.08 };
}

function plant(key: string, over: Partial<Plant> = {}): Plant {
  return {
    key,
    assetId: 'water-plant',
    tintSeed: null,
    parentKey: null,
    position: null,
    size: 1,
    minSize: 0.4,
    maxSize: 3,
    ...over,
  };
}

function context(plants: Plant[]): GrowthContext {
  return {
    plants: new Map(plants.map((p) => [p.key, p])),
    ground: (x) => 0.05 + x * 0.01,
    waterTop: WATER_TOP,
  };
}

describe('layoutPlantKeys', () => {
  it('numbers repeated seeds like the sim', () => {
    expect(layoutPlantKeys([7, 8, 7, 7])).toEqual(['s7', 's8', 's7-2', 's7-3']);
  });
});

describe('grownItem', () => {
  it('scales a root by its size on top of the layout scale', () => {
    const grown = grownItem(ref(1, 0, 0.8), context([plant('s1', { size: 1.5 })]));
    expect(grown.scale).toBeCloseTo(1.2, 6);
    expect(grown.position).toEqual([0, 0.05, 0.1]);
  });

  it('shrinks after a trim', () => {
    expect(grownItem(ref(1), context([plant('s1', { size: 0.5 })])).scale).toBeCloseTo(0.5, 6);
  });

  it('leaves the item untouched without state, at size 1, or for another asset', () => {
    const r = ref(1);
    expect(grownItem(r, context([])).scale).toBe(1);
    expect(grownItem(r, context([plant('s1')])).scale).toBe(1);
    expect(grownItem(r, context([plant('s1', { size: 2, assetId: 'java-fern' })]))).toBe(r.item);
  });

  it('keeps the leaf tips under the water line', () => {
    const grown = grownItem(ref(1), context([plant('s1', { size: 3 })]));
    expect(0.05 + 0.2 * grown.scale).toBeLessThanOrEqual(WATER_TOP);
    expect(grown.scale).toBeGreaterThan(1);
  });
});

describe('offsetEntries', () => {
  const offset = plant('s1.1', { parentKey: 's1', position: [0.2, -0.1], size: 0.5 });

  it('roots an offset on the substrate at its position, at the parent scale times its size', () => {
    const list = offsetEntries([ref(1, 0, 0.8)], context([plant('s1'), offset]));
    const entry = list.get('water-plant')?.[0];
    expect(entry).toMatchObject({ x: 0.2, z: -0.1, rank: -1 });
    expect(entry?.y).toBeCloseTo(0.05 + 0.2 * 0.01 - ROOT_DEPTH, 9);
    expect(entry?.scale).toBeCloseTo(0.4, 6);
  });

  it('follows an offset of an offset back to the layout plant', () => {
    const grandchild = plant('s1.1.1', { parentKey: 's1.1', position: [0.3, 0] });
    const list = offsetEntries([ref(1)], context([plant('s1'), offset, grandchild]));
    expect(list.get('water-plant')).toHaveLength(2);
  });

  it('skips an offset whose root left the layout or whose chain is cyclic', () => {
    const orphan = plant('s9.1', { parentKey: 's9', position: [0, 0] });
    const a = plant('a', { parentKey: 'b', position: [0, 0] });
    const b = plant('b', { parentKey: 'a', position: [0, 0] });
    expect(offsetEntries([ref(1)], context([orphan, a, b])).size).toBe(0);
  });

  it('drops an offset whose asset differs from its root, as after the layout swapped the plant', () => {
    const swapped = plant('s1.1', { assetId: 'java-fern', parentKey: 's1', position: [0, 0] });
    expect(offsetEntries([ref(1)], context([plant('s1'), swapped])).size).toBe(0);
  });

  it('is deterministic and varies between keys', () => {
    const state = context([plant('s1'), offset, { ...offset, key: 's1.2' }]);
    const first = offsetEntries([ref(1)], state).get('water-plant');
    const second = offsetEntries([ref(1)], state).get('water-plant');
    expect(second).toEqual(first);
    expect(first?.[0]?.yaw).not.toBe(first?.[1]?.yaw);
    expect(first?.[0]?.tone).not.toBe(first?.[1]?.tone);
  });

  it('keeps tone and tilt in range', () => {
    for (let i = 0; i < 200; i++) {
      const e = offsetEntry(`s1.${i}`, 0, 0, 0, 1);
      expect(e.tone).toBeGreaterThanOrEqual(0.86);
      expect(e.tone).toBeLessThanOrEqual(1.08);
      expect(Math.abs(e.tiltX)).toBeLessThanOrEqual(0.05);
    }
  });
});

describe('pickPlant', () => {
  const refs = [ref(1, 0), ref(2, 0.5)];
  const state = context([
    plant('s1', { size: 2 }),
    plant('s2'),
    plant('s2.1', { parentKey: 's2', position: [-0.5, 0.1], size: 0.7 }),
  ]);
  const downAt = (x: number, z: number) => new Ray(new Vector3(x, 0.3, z), new Vector3(0, -1, 0));

  it('returns the key and current size of the plant under the ray', () => {
    const pick = pickPlant(downAt(0, 0.1), pickablePlants(refs, state));
    expect(pick).toMatchObject({ key: 's1', size: 2, minSize: 0.4, maxSize: 3 });
  });

  it('picks an offset by its own key', () => {
    expect(pickPlant(downAt(-0.5, 0.1), pickablePlants(refs, state))).toMatchObject({
      key: 's2.1',
      size: 0.7,
    });
  });

  it('picks nothing in open water', () => {
    expect(pickPlant(downAt(0.25, 0.1), pickablePlants(refs, state))).toBeNull();
  });

  it('takes the nearer of two plants on the ray', () => {
    const both = pickablePlants([ref(1, 0), ref(2, 0)], context([plant('s1'), plant('s2')]));
    const nearFirst = new Ray(new Vector3(0, 0.1, 1), new Vector3(0, 0, -1));
    const nearSecond = new Ray(new Vector3(0, 0.1, -1), new Vector3(0, 0, 1));
    expect(pickPlant(nearFirst, both)?.key).toBe('s1');
    expect(pickPlant(nearSecond, both)?.key).toBe('s1');
    const shifted = pickablePlants(
      [ref(1, 0), { ...ref(2, 0), item: { ...item(2, 0), position: [0, 0.05, 0.6] } }],
      context([plant('s1'), plant('s2')]),
    );
    expect(pickPlant(nearFirst, shifted)?.key).toBe('s2');
    expect(pickPlant(nearSecond, shifted)?.key).toBe('s1');
  });
});

describe('PlantGroup growth updates', () => {
  const bounds: FlowBounds = { minX: -0.5, maxX: 0.5, minZ: -0.25, maxZ: 0.25, minY: 0, maxY: 0.5 };
  const model: LoadedModel = {
    primitives: [
      { geometry: new BoxGeometry(0.1, 0.3, 0.1), material: new MeshStandardMaterial() },
    ],
  };
  const meshes = (group: PlantGroup) =>
    group.object.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);

  function pumped(): CurrentField {
    const current = new CurrentField();
    current.setWaveMaker(
      new FlowField(bounds, { direction: [0.6, 0.8], speedMps: 0.12, mode: 'steady', periodS: 8 }),
      0,
    );
    return current;
  }

  it('rewrites offsets in the same meshes without allocating new ones', () => {
    const group = new PlantGroup(
      'water-plant',
      model,
      [offsetEntry('a', 0, 0, 0, 1)],
      pumped(),
      16,
    );
    const before = meshes(group);
    const matrices = before.map((m) => m.instanceMatrix);
    const live = Array.from({ length: 5 }, (_, i) =>
      offsetEntry(`k${i}`, i * 0.1 - 0.2, 0.05, 0, 1),
    );
    expect(group.setLive(live)).toBe(true);
    expect(meshes(group)).toEqual(before);
    before.forEach((m, i) => expect(m.instanceMatrix).toBe(matrices[i]));
    expect(before.every((m) => m.count === 5)).toBe(true);
    expect(group.total).toBe(5);
    expect(group.setLive([])).toBe(true);
    expect(before.every((m) => m.count === 0)).toBe(true);
  });

  it('refuses more instances than its capacity so the caller can build a larger group', () => {
    const group = new PlantGroup('water-plant', model, [offsetEntry('a', 0, 0, 0, 1)], pumped(), 4);
    const five = Array.from({ length: 5 }, (_, i) => offsetEntry(`k${i}`, 0, 0, 0, 1));
    expect(group.setLive(five)).toBe(false);
    expect(group.visible).toBe(1);
  });

  it('keeps offsets swaying in the pump current and always visible', () => {
    const group = new PlantGroup('water-plant', model, [], pumped(), 8);
    group.setLive([offsetEntry('k', 0.1, 0.05, 0, 1)]);
    group.setDensity(0);
    expect(group.visible).toBe(1);
    const gain = Math.abs(group.pumpGain[0] ?? 0) + Math.abs(group.pumpGain[1] ?? 0);
    expect(gain).toBeGreaterThan(1e-3);
  });

  it('resizes a layout plant in place and keeps the layout signature current', () => {
    const layout = offsetEntry('s1', 0, 0.05, 0, 1);
    const group = new PlantGroup('water-plant', model, [layout], pumped());
    const mesh = meshes(group)[0] as InstancedMesh;
    group.setGrown(0, { ...layout, scale: 1.7 });
    expect(group.layoutSignature).toBe(JSON.stringify([{ ...layout, scale: 1.7 }]));
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    expect(new Vector3().setFromMatrixScale(m).y).toBeCloseTo(1.7, 5);
  });
});

describe('offsetCapacity', () => {
  it('rounds up to a power of two with a floor', () => {
    expect(offsetCapacity(1)).toBe(16);
    expect(offsetCapacity(17)).toBe(32);
    expect(offsetCapacity(400)).toBe(512);
  });
});
