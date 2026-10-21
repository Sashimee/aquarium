import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { SimPolyps } from '@aquarium/sim';
import type { CatalogEntry } from './assets';
import { createCoralGlowNode, Hardscape } from './hardscape';
import { generateEuphyllia } from './euphyllia';
import {
  EUPHYLLIA_POLYP_GAIN,
  PolypSignal,
  polypGain,
  polypSize,
  type PolypSource,
} from './polyps';

function source() {
  const listeners = new Set<(extension: number, event: SimPolyps) => void>();
  const fake: PolypSource & {
    emit(extension: number, epoch: number, tick: number): void;
    readonly listeners: ReadonlySet<unknown>;
  } = {
    listeners,
    onPolyps(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(extension, epoch, tick) {
      for (const l of listeners) l(extension, { type: 'polyps', epoch, tick, extension });
    },
  };
  return fake;
}

describe('polyp gain', () => {
  it('moves the nocturnal feeders, not the rock', () => {
    expect(polypGain('acropora-cytherea')).toBe(1);
    expect(polypGain('brain-coral')).toBeGreaterThan(0);
    expect(polypGain('host-anemone')).toBeLessThan(EUPHYLLIA_POLYP_GAIN);
    expect(polypGain('rock-a')).toBe(0);
  });

  it('retracts to 1 - gain by day and is fully out at night', () => {
    expect(polypSize(0.8, 0)).toBeCloseTo(0.2);
    expect(polypSize(0.8, 1)).toBe(1);
    expect(polypSize(0, 0)).toBe(1);
  });
});

describe('PolypSignal', () => {
  it('follows the sim and clamps', () => {
    const signal = new PolypSignal();
    const sim = source();
    signal.bind(sim);
    sim.emit(0.4, 1, 10);
    expect(signal.extension).toBeCloseTo(0.4);
    sim.emit(3, 1, 11);
    expect(signal.extension).toBe(1);
  });

  it('drops events from an older world or an older tick', () => {
    const signal = new PolypSignal();
    signal.accept(0.9, { epoch: 2, tick: 50 });
    signal.accept(0.1, { epoch: 1, tick: 999 });
    signal.accept(0.2, { epoch: 2, tick: 49 });
    expect(signal.extension).toBeCloseTo(0.9);
    signal.accept(0.3, { epoch: 3, tick: 0 });
    expect(signal.extension).toBeCloseTo(0.3);
  });

  it('ignores a non-finite extension', () => {
    const signal = new PolypSignal();
    signal.accept(0.5, { epoch: 1, tick: 1 });
    signal.accept(Number.NaN, { epoch: 1, tick: 2 });
    expect(signal.extension).toBe(0.5);
  });

  it('unsubscribes on rebind and dispose, and accepts a new client restarting its epoch', () => {
    const signal = new PolypSignal();
    const first = source();
    signal.bind(first);
    first.emit(1, 7, 100);
    const second = source();
    signal.bind(second);
    expect(first.listeners.size).toBe(0);
    second.emit(0.25, 1, 1);
    expect(signal.extension).toBeCloseTo(0.25);
    signal.dispose();
    expect(second.listeners.size).toBe(0);
    second.emit(0.9, 1, 2);
    expect(signal.extension).toBeCloseTo(0.25);
  });
});

describe('scene wiring', () => {
  const entry = (id: string): CatalogEntry => ({ id, kind: 'coral', lods: [{ file: 'x.glb' }] });
  const item = (assetId: string): DecorItem =>
    ({ assetId, position: [0, 0, 0], rotationY: 0, scale: 1 }) as DecorItem;
  const model = () => ({
    primitives: [{ geometry: new BoxGeometry(), material: new MeshStandardMaterial() }],
  });

  it('gives a reef polyp coral a position node driven by the shared uniform', () => {
    const hardscape = new Hardscape('reef', createCoralGlowNode(uniform(0)), uniform(0));
    hardscape.add(entry('brain-coral'), model(), item('brain-coral'));
    const coral = (hardscape.group.children[0] as Mesh).material as MeshStandardNodeMaterial;
    expect(coral.positionNode).not.toBeNull();
  });

  it('records the offset to the tentacle root for tentacles only', () => {
    const mesh = generateEuphyllia('hammer', 3, 1);
    expect(mesh.retract.length).toBe(mesh.positions.length);
    let moving = 0;
    let still = 0;
    for (let i = 0; i < mesh.retract.length; i += 3) {
      const [x = 0, y = 0, z = 0] = mesh.retract.subarray(i, i + 3);
      if (Math.hypot(x, y, z) > 0) moving++;
      else still++;
    }
    expect(moving).toBeGreaterThan(0);
    expect(still).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(generateEuphyllia('torch', 9, 2).retract).toEqual(
      generateEuphyllia('torch', 9, 2).retract,
    );
  });
});
