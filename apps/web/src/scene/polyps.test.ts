import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  type Node,
} from 'three/webgpu';
import { float, uniform, vec3 } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { SimPolyps } from '@aquarium/sim';
import type { CatalogEntry } from './assets';
import { contractedTentacles } from './anemone';
import {
  createCoralGlowNode,
  Hardscape,
  SWELL_NORMAL_ATTRIBUTE,
  swelledPosition,
  weldedNormals,
} from './hardscape';
import { generateEuphyllia, retractedPosition } from './euphyllia';
import {
  EUPHYLLIA_POLYP_GAIN,
  PolypSignal,
  contractionGain,
  polypGain,
  polypSize,
  polypSizeNode,
  type PolypSource,
} from './polyps';

interface GraphNode {
  op?: string;
  method?: string;
  aNode?: GraphNode;
  bNode?: GraphNode;
  node?: GraphNode;
  nodes?: GraphNode[];
  components?: string;
  value?: unknown;
}

function evaluate(root: Node<'float'> | Node<'vec3'>): number[] {
  const walk = (n: GraphNode): number[] => {
    if (n.nodes) return n.nodes.flatMap(walk);
    if (n.method === 'oneMinus') return walk(n.aNode as GraphNode).map((x) => 1 - x);
    if (n.method) throw new Error(`unsupported math ${n.method}`);
    if (n.op) {
      const a = walk(n.aNode as GraphNode);
      const b = walk(n.bNode as GraphNode);
      const size = Math.max(a.length, b.length);
      const apply = {
        '+': (x: number, y: number) => x + y,
        '-': (x: number, y: number) => x - y,
        '*': (x: number, y: number) => x * y,
        '/': (x: number, y: number) => x / y,
      }[n.op];
      if (!apply) throw new Error(`unsupported operator ${n.op}`);
      return Array.from({ length: size }, (_, i) =>
        apply(a[i % a.length] ?? 0, b[i % b.length] ?? 0),
      );
    }
    if (n.components) {
      const inner = walk(n.node as GraphNode);
      return [...n.components].map((c) => inner['xyzw'.indexOf(c)] ?? Number.NaN);
    }
    if (n.node) return walk(n.node);
    const v = n.value;
    if (typeof v === 'number') return [v];
    const o = v as { x: number; y: number; z: number };
    return [o.x, o.y, o.z];
  };
  return walk(root as unknown as GraphNode);
}

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
    expect(polypGain('acropora-palmata')).toBe(1);
    expect(polypGain('brain-coral')).toBe(0.8);
    expect(polypGain('host-anemone')).toBe(0);
    expect(polypGain('rock-a')).toBe(0);
  });

  it('contracts the anemone a little at night and nothing else', () => {
    expect(contractionGain('host-anemone')).toBe(0.2);
    expect(EUPHYLLIA_POLYP_GAIN).toBe(0.15);
    expect(contractionGain('acropora-cytherea')).toBe(0);
    expect(contractionGain('brain-coral')).toBe(0);
  });

  it('keeps the authored daytime shape at extension 0 and contracts toward night', () => {
    expect(polypSize(0.2, 0)).toBe(1);
    expect(polypSize(0.2, 1)).toBeCloseTo(0.8);
    expect(polypSize(0.2, 0.5)).toBeCloseTo(0.9);
    expect(polypSize(0, 1)).toBe(1);
  });

  it('computes the same size on the GPU as on the CPU', () => {
    for (const gain of [0, 0.15, 0.2, 1]) {
      for (const extension of [0, 0.25, 1]) {
        const [size] = evaluate(polypSizeNode(float(extension), gain));
        expect(size).toBeCloseTo(polypSize(gain, extension), 6);
      }
    }
  });
});

describe('contraction node math', () => {
  const position = vec3(0.2, 0.1, -0.4);

  it('leaves the daytime anemone untouched and pulls tips in at night', () => {
    const day = evaluate(contractedTentacles(polypSizeNode(float(0), 0.2), position, float(1)));
    expect(day).toEqual([expect.closeTo(0.2, 6), expect.closeTo(0.1, 6), expect.closeTo(-0.4, 6)]);
    const night = evaluate(contractedTentacles(polypSizeNode(float(1), 0.2), position, float(1)));
    expect(night[0]).toBeCloseTo(0.2 * 0.8, 6);
    expect(night[1]).toBeCloseTo(0.1, 6);
    expect(night[2]).toBeCloseTo(-0.4 * 0.8, 6);
  });

  it('does not move the base of the anemone, whose sway weight is 0', () => {
    const night = evaluate(contractedTentacles(polypSizeNode(float(1), 0.2), position, float(0)));
    expect(night[0]).toBeCloseTo(0.2, 6);
    expect(night[2]).toBeCloseTo(-0.4, 6);
  });

  it('slides Euphyllia tentacle vertices toward their root and never past it', () => {
    const retract = vec3(-0.1, 0.2, 0.3);
    const night = evaluate(
      retractedPosition(polypSizeNode(float(1), EUPHYLLIA_POLYP_GAIN), position, retract),
    );
    expect(night[0]).toBeCloseTo(0.2 - 0.1 * EUPHYLLIA_POLYP_GAIN, 6);
    expect(night[1]).toBeCloseTo(0.1 + 0.2 * EUPHYLLIA_POLYP_GAIN, 6);
    expect(night[2]).toBeCloseTo(-0.4 + 0.3 * EUPHYLLIA_POLYP_GAIN, 6);
    const day = evaluate(
      retractedPosition(polypSizeNode(float(0), EUPHYLLIA_POLYP_GAIN), position, retract),
    );
    expect(day).toEqual([expect.closeTo(0.2, 6), expect.closeTo(0.1, 6), expect.closeTo(-0.4, 6)]);
  });
});

describe('swell node math', () => {
  const position = vec3(0, 0, 0);
  const normal = vec3(0, 1, 0);

  it('pushes outward along the normal at night and sits flush by day', () => {
    const night = evaluate(swelledPosition(float(1), 1, position, normal, vec3(1, 1, 1)));
    expect(night[1]).toBeCloseTo(0.0015, 8);
    const day = evaluate(swelledPosition(float(0), 1, position, normal, vec3(1, 1, 1)));
    expect(day).toEqual([0, 0, 0]);
  });

  it('scales with the gain', () => {
    const [, y] = evaluate(swelledPosition(float(1), 0.8, position, normal, vec3(1, 1, 1)));
    expect(y).toBeCloseTo(0.0012, 8);
  });

  it('gives a squashed coral the same world swell on top as on its sides', () => {
    const scale = vec3(1, 0.55, 1);
    const top = evaluate(swelledPosition(float(1), 1, position, vec3(0, 1, 0), scale));
    const side = evaluate(swelledPosition(float(1), 1, position, vec3(1, 0, 0), scale));
    expect((top[1] ?? 0) * 0.55).toBeCloseTo(0.0015, 8);
    expect(side[0]).toBeCloseTo(0.0015, 8);
  });
});

describe('weldedNormals', () => {
  function geometry(positions: number[], normals: number[]): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
    g.setAttribute('normal', new BufferAttribute(Float32Array.from(normals), 3));
    return g;
  }

  it('gives vertices that share a position the same direction', () => {
    const g = geometry([0, 0, 0, 0, 0, 0, 1, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const out = weldedNormals(g);
    expect([...out.subarray(0, 3)]).toEqual([...out.subarray(3, 6)]);
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect([...out.subarray(6, 9)]).toEqual([0, 0, 1]);
  });

  it('keeps a vertex still where the shared normals cancel', () => {
    const g = geometry([0, 0, 0, 0, 0, 0], [0, 1, 0, 0, -1, 0]);
    expect([...weldedNormals(g)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('is baked onto a swelling coral geometry once, at load', () => {
    const hardscape = new Hardscape('reef', createCoralGlowNode(uniform(0)), uniform(0));
    const g = new BoxGeometry();
    const entry: CatalogEntry = { id: 'brain-coral', kind: 'coral', lods: [{ file: 'x.glb' }] };
    const decor = {
      assetId: 'brain-coral',
      position: [0, 0, 0],
      rotationY: 0,
      scale: 1,
    } as DecorItem;
    const model = { primitives: [{ geometry: g, material: new MeshStandardMaterial() }] };
    hardscape.add(entry, model, decor);
    const baked = g.getAttribute(SWELL_NORMAL_ATTRIBUTE);
    expect(baked).toBeDefined();
    hardscape.add(entry, model, decor);
    expect(g.getAttribute(SWELL_NORMAL_ATTRIBUTE)).toBe(baked);
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

  it('clamps a negative extension to 0', () => {
    const signal = new PolypSignal();
    signal.accept(-2, { epoch: 1, tick: 1 });
    expect(signal.extension).toBe(0);
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

  it.each(['hammer', 'torch'] as const)(
    'anchors every %s tentacle vertex, tube and tip, to a root at the foot of its tube',
    (variant) => {
      const mesh = generateEuphyllia(variant, 3, 1);
      const groups = new Map<string, { root: number[]; points: number[][] }>();
      for (let i = 0; i < mesh.retract.length; i += 3) {
        const r = [...mesh.retract.subarray(i, i + 3)];
        if (Math.hypot(...(r as [number, number, number])) === 0) continue;
        const p = [...mesh.positions.subarray(i, i + 3)];
        const root = p.map((c, k) => c + (r[k] as number));
        const key = root.map((c) => c.toFixed(5)).join(',');
        const group = groups.get(key) ?? { root, points: [] };
        group.points.push(p);
        groups.set(key, group);
      }
      expect(groups.size).toBeGreaterThan(5);
      for (const { root, points } of groups.values()) {
        const nearest = Math.min(
          ...points.map((p) => Math.hypot(...p.map((c, k) => c - (root[k] as number)))),
        );
        const farthest = Math.max(
          ...points.map((p) => Math.hypot(...p.map((c, k) => c - (root[k] as number)))),
        );
        expect(nearest).toBeLessThan(0.003);
        expect(farthest).toBeLessThan(0.08);
        expect(points.length).toBeGreaterThan(4);
      }
    },
  );

  it('is deterministic', () => {
    expect(generateEuphyllia('torch', 9, 2).retract).toEqual(
      generateEuphyllia('torch', 9, 2).retract,
    );
  });
});
