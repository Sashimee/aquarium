import { BoxGeometry, BufferAttribute, MeshStandardMaterial } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { FlowField, type FlowBounds, type WaveMakerSettings } from '@aquarium/sim';
import type { LoadedModel } from './assets';
import { CurrentField } from './current';
import { PlantGroup, type PlantEntry } from './plants';

const bounds: FlowBounds = { minX: -0.5, maxX: 0.5, minZ: -0.25, maxZ: 0.25, minY: 0, maxY: 0.5 };
const pump: WaveMakerSettings = {
  direction: [0.6, 0.8],
  speedMps: 0.12,
  mode: 'steady',
  periodS: 8,
};

function plant(x: number, z: number): PlantEntry {
  return { x, y: 0.05, z, yaw: 0, tiltX: 0, tiltZ: 0, scale: 1, tone: 1, rank: -1 };
}

function pumpedCurrent(): CurrentField {
  const current = new CurrentField();
  current.setWaveMaker(new FlowField(bounds, pump), 0);
  return current;
}

function modelOf(): LoadedModel {
  return {
    primitives: [
      { geometry: new BoxGeometry(0.1, 0.3, 0.1), material: new MeshStandardMaterial() },
    ],
  };
}

function gainAt(current: CurrentField, entry: PlantEntry): [number, number] {
  const out = [0, 0];
  current.pumpGainAt(entry.x, entry.y, entry.z, out);
  return [out[0] ?? 0, out[1] ?? 0];
}

function expectGain(group: PlantGroup, index: number, expected: readonly [number, number]) {
  expect(group.pumpGain[index * 2]).toBeCloseTo(expected[0], 5);
  expect(group.pumpGain[index * 2 + 1]).toBeCloseTo(expected[1], 5);
}

describe('PlantGroup pump gain', () => {
  it('keeps each group on its own pump data when groups share one model geometry', () => {
    const current = pumpedCurrent();
    const model = modelOf();
    const first = [plant(-0.3, -0.1), plant(0.2, 0.1), plant(0.4, 0.15)];
    const second = [plant(0.1, -0.05)];
    const a = new PlantGroup('java-fern', model, first, current);
    const b = new PlantGroup('java-fern', model, second, current);

    expect(a.pumpGain).not.toBe(b.pumpGain);
    expect(a.pumpGain.length).toBe(first.length * 2);
    expect(b.pumpGain.length).toBe(second.length * 2);
    first.forEach((entry, i) => expectGain(a, i, gainAt(current, entry)));
    expectGain(b, 0, gainAt(current, second[0] ?? plant(0, 0)));
    expect(Math.abs(a.pumpGain[0] ?? 0) + Math.abs(a.pumpGain[1] ?? 0)).toBeGreaterThan(1e-3);
    expect(model.primitives[0]?.geometry.getAttribute('_pump')).toBeUndefined();

    b.dispose();
    first.forEach((entry, i) => expectGain(a, i, gainAt(current, entry)));
  });

  it('gives the dragged plant the gain of its new spot', () => {
    const current = pumpedCurrent();
    const kept = plant(-0.3, -0.1);
    const group = new PlantGroup('java-fern', modelOf(), [kept, plant(0.2, 0.1)], current);
    const moved = plant(0.4, -0.2);
    const before = group.pumpGain.slice(2, 4);
    const spy = vi.spyOn(current, 'pumpGainAt');

    group.setEntry(1, moved);

    expect(spy).toHaveBeenCalledWith(moved.x, moved.y, moved.z, expect.anything());
    expect(group.pumpGain.slice(2, 4)).not.toEqual(before);
    expectGain(group, 1, gainAt(current, moved));
    expectGain(group, 0, gainAt(current, kept));
  });

  it('refreshes the gains when the pump changes', () => {
    const current = new CurrentField();
    const entry = plant(0.2, 0.1);
    const group = new PlantGroup('java-fern', modelOf(), [entry], current);
    expect(group.pumpGain[0]).toBe(0);
    current.setWaveMaker(new FlowField(bounds, pump), 0);
    expectGain(group, 0, gainAt(current, entry));
    expect(Math.abs(group.pumpGain[0] ?? 0) + Math.abs(group.pumpGain[1] ?? 0)).toBeGreaterThan(
      1e-3,
    );
  });

  it('flags the pump attribute for upload when an entry moves or the pump changes', () => {
    const uploads: Float32Array[] = [];
    const setter = Object.getOwnPropertyDescriptor(BufferAttribute.prototype, 'needsUpdate')?.set;
    if (!setter) throw new Error('BufferAttribute.needsUpdate has no setter to observe');
    const spy = vi
      .spyOn(BufferAttribute.prototype, 'needsUpdate', 'set')
      .mockImplementation(function (this: BufferAttribute, value: boolean) {
        uploads.push(this.array as Float32Array);
        setter.call(this, value);
      });
    try {
      const current = new CurrentField();
      const group = new PlantGroup('java-fern', modelOf(), [plant(0.2, 0.1)], current);
      const flagged = () => uploads.filter((array) => array === group.pumpGain).length;

      const afterBuild = flagged();
      current.setWaveMaker(new FlowField(bounds, pump), 0);
      const afterPump = flagged();
      expect(afterPump).toBeGreaterThan(afterBuild);
      group.setEntry(0, plant(0.3, 0.1));
      expect(flagged()).toBeGreaterThan(afterPump);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops following the pump once disposed', () => {
    const current = new CurrentField();
    const group = new PlantGroup('java-fern', modelOf(), [plant(0.2, 0.1)], current);
    group.dispose();
    current.setWaveMaker(new FlowField(bounds, pump), 0);
    expect(group.pumpGain[0]).toBe(0);
    expect(group.pumpGain[1]).toBe(0);
  });
});
