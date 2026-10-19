import { describe, expect, it } from 'vitest';
import {
  Color,
  ColorManagement,
  ConditionalNode,
  ConstNode,
  ConvertNode,
  JoinNode,
  MaterialNode,
  MathNode,
  OperatorNode,
  SplitNode,
  Texture,
  TextureNode,
  UniformNode,
  VarNode,
  Vector3,
  Vector4,
  type Node,
} from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { ImpostorInstanceData, ImpostorSlot } from './impostor';
import { FishImpostorMaterial } from './impostorMaterial';
import { FIN_OPACITY_FLOOR, type FishMaterialFeatures } from './material';
import { renderProfile } from './profiles';
import { SWIM_MODES } from './swim';

const profile = renderProfile('neon-tetra');

const albedoAtlas = new Texture();
const normalAtlas = new Texture();

function impostorMaterial(): FishImpostorMaterial {
  return new FishImpostorMaterial({
    assetId: profile.assetId,
    atlas: {
      info: {
        grid: 9,
        frameSize: 128,
        pivot: [0, 0, 0],
        radius: 0.05,
        albedoFile: 'a.ktx2',
        normalFile: 'n.ktx2',
      },
      albedo: albedoAtlas,
      normal: normalAtlas,
    },
    profile,
    mode: SWIM_MODES.carangiform,
    zMin: -0.05,
    zMax: 0.05,
    instances: new ImpostorInstanceData(1),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
  });
}

/** `Node.traverse` revisits shared subgraphs, and the four atlas taps share most of theirs. */
function readsIllness(node: Node | null): boolean {
  const seen = new Set<Node>();
  const pending = node === null ? [] : [node];
  for (let n = pending.pop(); n !== undefined; n = pending.pop()) {
    if (seen.has(n)) continue;
    seen.add(n);
    const buffer = n as Node & { isBufferNode?: boolean; bufferOffset?: number };
    if (buffer.isBufferNode === true && buffer.bufferOffset === ImpostorSlot.Illness) return true;
    pending.push(...n.getChildren());
  }
  return false;
}

const TIERS: readonly FishMaterialFeatures[] = [
  { fins: 'cutout', iridescence: false, clearcoat: false, gills: false },
  { fins: 'coverage', iridescence: false, clearcoat: true, gills: false },
  { fins: 'stochastic', iridescence: true, clearcoat: true, gills: true },
];

describe('FishImpostorMaterial disease', () => {
  it('tints the albedo and dulls the surface by the signs on every tier', () => {
    for (const features of TIERS) {
      const material = impostorMaterial();
      material.setFeatures(features);
      expect(readsIllness(material.colorNode)).toBe(true);
      expect(readsIllness(material.roughnessNode)).toBe(true);
      expect(material.clearcoatNode === null || readsIllness(material.clearcoatNode)).toBe(true);
    }
  });

  it('cuts rotted fin away whether fins use alpha-to-coverage or a cutout', () => {
    for (const features of TIERS) {
      const material = impostorMaterial();
      material.setFeatures(features);
      const cut = material.alphaToCoverage ? material.opacityNode : material.maskNode;
      expect(readsIllness(cut)).toBe(true);
    }
  });
});

interface Inputs {
  texel: readonly [number, number, number, number];
  finMask: number;
  tint: readonly [number, number, number];
  pale: number;
}

/**
 * Evaluates a material output on the CPU with the atlas taps and instance blocks fed constant
 * values, so the graph itself is held to the healthy formulas rather than a copy of them.
 */
function evaluate(node: Node, inputs: Inputs, signs: readonly [number, number, number]): number[] {
  const leaf = (n: Node): number[] | undefined => {
    if (n instanceof TextureNode) {
      if (n.value === albedoAtlas) return [...inputs.texel];
      if (n.value === normalAtlas) return [0.5, 0.5, inputs.finMask, 0.5];
    }
    const buffer = n as Node & { isBufferNode?: boolean; bufferOffset?: number };
    if (buffer.isBufferNode === true) {
      switch (buffer.bufferOffset) {
        case ImpostorSlot.View:
          return [0, 0, 1, inputs.pale];
        case ImpostorSlot.Tint:
          return [...inputs.tint, 0];
        case ImpostorSlot.Frames:
          return [0, 0, 0.25, 0.5];
        case ImpostorSlot.Illness:
          return [...signs, 0];
      }
    }
    if (n instanceof MaterialNode && n.scope === MaterialNode.ROUGHNESS) return [profile.roughness];
    return undefined;
  };
  const zip = (a: number[], b: number[], f: (x: number, y: number) => number): number[] =>
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      f(a.length === 1 ? (a[0] ?? 0) : (a[i] ?? 0), b.length === 1 ? (b[0] ?? 0) : (b[i] ?? 0)),
    );
  const ev = (n: Node | null): number[] => {
    if (n === null) throw new Error('evaluate: missing operand');
    const fed = leaf(n);
    if (fed !== undefined) return fed;
    if (n instanceof UniformNode || n instanceof ConstNode) {
      const value: unknown = n.value;
      if (typeof value === 'number') return [value];
      if (typeof value === 'boolean') return [value ? 1 : 0];
      if (value instanceof Vector3 || value instanceof Vector4 || value instanceof Color) {
        return value.toArray();
      }
      throw new Error(`evaluate: unsupported ${n.type} value`);
    }
    if (n instanceof VarNode || n instanceof ConvertNode) return ev(n.node);
    if (n instanceof JoinNode) return n.nodes.flatMap((part) => ev(part));
    if (n instanceof SplitNode) {
      const v = ev(n.node);
      return [...n.components].map((c) => v['xyzw'.indexOf(c)] ?? Number.NaN);
    }
    if (n instanceof ConditionalNode) {
      return (ev(n.condNode)[0] ?? 0) !== 0 ? ev(n.ifNode) : ev(n.elseNode);
    }
    if (n instanceof OperatorNode) {
      const a = ev(n.aNode);
      const b = ev(n.bNode);
      switch (n.op) {
        case '+':
          return zip(a, b, (x, y) => x + y);
        case '-':
          return zip(a, b, (x, y) => x - y);
        case '*':
          return zip(a, b, (x, y) => x * y);
        case '/':
          return zip(a, b, (x, y) => x / y);
        case '>':
          return zip(a, b, (x, y) => (x > y ? 1 : 0));
        case '&&':
          return zip(a, b, (x, y) => (x !== 0 && y !== 0 ? 1 : 0));
      }
      throw new Error(`evaluate: unsupported operator ${n.op}`);
    }
    if (n instanceof MathNode) {
      const a = (): number[] => ev(n.aNode);
      const b = (): number[] => ev(n.bNode);
      const c = (): number[] => ev(n.cNode);
      switch (n.method) {
        case MathNode.ONE_MINUS:
          return a().map((x) => 1 - x);
        case MathNode.MAX:
          return zip(a(), b(), Math.max);
        case MathNode.MIN:
          return zip(a(), b(), Math.min);
        case MathNode.DOT:
          return [zip(a(), b(), (x, y) => x * y).reduce((sum, x) => sum + x, 0)];
        case MathNode.CLAMP:
          return zip(zip(a(), b(), Math.max), c(), Math.min);
        case MathNode.MIX: {
          const t = c();
          return zip(
            zip(a(), t, (x, s) => x * (1 - s)),
            zip(b(), t, (y, s) => y * s),
            (x, y) => x + y,
          );
        }
        case MathNode.SMOOTHSTEP: {
          const lo = a();
          const hi = b();
          return c().map((x, i) => {
            const l = lo.length === 1 ? (lo[0] ?? 0) : (lo[i] ?? 0);
            const h = hi.length === 1 ? (hi[0] ?? 0) : (hi[i] ?? 0);
            const t = Math.min(Math.max((x - l) / (h - l), 0), 1);
            return t * t * (3 - 2 * t);
          });
        }
      }
      throw new Error(`evaluate: unsupported math ${n.method}`);
    }
    throw new Error(`evaluate: unsupported node ${n.type}`);
  };
  return ev(node);
}

describe('FishImpostorMaterial healthy fish', () => {
  const healthy = [0, 0, 0] as const;
  const smoothstep = (lo: number, hi: number, x: number): number => {
    const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const samples: readonly Inputs[] = [
    { texel: [0.2, 0.45, 0.8, 0.9], finMask: 0.05, tint: [1, 0.9, 0.8], pale: 0 },
    { texel: [0.6, 0.3, 0.1, 0.7], finMask: 0.3, tint: [0.9, 1, 1], pale: 0.4 },
    { texel: [0.9, 0.8, 0.7, 0.4], finMask: 0.85, tint: [1, 1, 1], pale: 1 },
  ];

  it('keeps the colour, roughness, opacity, cutout and clearcoat it had before disease', () => {
    const lum = ColorManagement.getLuminanceCoefficients(new Vector3()).toArray();
    let checked = 0;
    for (const features of TIERS) {
      const material = impostorMaterial();
      material.setFeatures(features);
      const translucent = features.fins !== 'cutout' && profile.finTransmission > 0;
      for (const inputs of samples) {
        const [r, g, b, coverage] = inputs.texel;
        const finAmount = smoothstep(0.08, 0.5, inputs.finMask);
        const base = [r * inputs.tint[0], g * inputs.tint[1], b * inputs.tint[2]];
        const grey = base.reduce((sum, x, i) => sum + x * (lum[i] ?? 0), 0) * 0.8 + 0.06;
        const t = inputs.pale * 0.85;
        const colour = base.map((x) => x * (1 - t) + grey * t);
        const finAlpha =
          coverage * (1 - finAmount * profile.finTransmission * (1 - FIN_OPACITY_FLOOR));

        const at = (node: Node | null): number[] => {
          expect(node).not.toBeNull();
          return node === null ? [] : evaluate(node, inputs, healthy);
        };
        at(material.colorNode).forEach((v, i) =>
          expect(v).toBeCloseTo(colour[i] ?? Number.NaN, 12),
        );
        expect(at(material.roughnessNode)).toEqual([profile.roughness]);
        if (material.alphaToCoverage) {
          const [opacity] = at(material.opacityNode);
          expect(opacity).toBeCloseTo(translucent ? finAlpha : coverage, 12);
          expect(at(material.maskNode)).toEqual([coverage > 0.02 ? 1 : 0]);
        } else {
          expect(material.opacityNode).toBeNull();
          expect(at(material.maskNode)).toEqual([coverage > 0.5 ? 1 : 0]);
        }
        if (features.clearcoat) {
          const [clearcoat] = at(material.clearcoatNode);
          expect(clearcoat).toBeCloseTo(0.6 * (1 - finAmount) + 0.2 * finAmount, 12);
        } else {
          expect(material.clearcoatNode).toBeNull();
        }
        checked++;
      }
    }
    expect(checked).toBe(TIERS.length * samples.length);
  });

  it('departs from the healthy look once a sign is present', () => {
    const material = impostorMaterial();
    material.setFeatures({ fins: 'coverage', iridescence: false, clearcoat: true, gills: false });
    const inputs: Inputs = { texel: [0.6, 0.3, 0.1, 0.7], finMask: 0.3, tint: [1, 1, 1], pale: 0 };
    const colourOf = (signs: readonly [number, number, number]): number[] =>
      material.colorNode === null ? [] : evaluate(material.colorNode, inputs, signs);
    expect(colourOf([0.6, 0, 0])).not.toEqual(colourOf([0, 0, 0]));
    expect(colourOf([0, 0, 0.6])).not.toEqual(colourOf([0, 0, 0]));
  });
});
