import { describe, expect, it } from 'vitest';
import {
  AttributeNode,
  BoxGeometry,
  BufferAttribute,
  DirectionalLight,
  InstancedMesh,
  MeshStandardMaterial,
  Vector3,
  type Node,
} from 'three/webgpu';
import { float, uniform, vec3 } from 'three/tsl';
import {
  FishInstanceData,
  INSTANCE_STRIDE,
  InstanceSlot,
  WALKER_INSTANCE_STRIDE,
  WalkerSlot,
} from './instances';
import { reversedSmoothsteps } from '../engine/reversedSmoothsteps';
import { buildShaders, mainBodyDepths } from '../engine/shaderFixtures';
import { FIN_ATTRIBUTE } from './assets';
import {
  AUTHORED_SURFACE_MATERIAL,
  finDisplay,
  FishMaterial,
  keepsAuthoredSurface,
} from './material';
import { renderProfile, type FishRenderProfile } from './profiles';
import { SWIM_MODES } from './swim';

const pleco = renderProfile('bristlenose-pleco');
const iridescent = renderProfile('neon-tetra');

function fishMaterial(
  source: MeshStandardMaterial,
  mouth = false,
  displays = false,
  profile: FishRenderProfile = pleco,
): FishMaterial {
  return new FishMaterial({
    source,
    assetId: profile.assetId,
    profile,
    locomotion: { kind: 'swim', mode: SWIM_MODES.carangiform },
    zMin: -0.05,
    zMax: 0.05,
    instances: new FishInstanceData(1, INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth,
    displays,
  });
}

function shrimpMaterial(): FishMaterial {
  return new FishMaterial({
    source: new MeshStandardMaterial(),
    assetId: 'cherry-shrimp',
    profile: renderProfile('cherry-shrimp'),
    locomotion: {
      kind: 'walk',
      rig: {
        bodyLength: 0.025,
        hinge: { y: 0, z: 0 },
        telsonZ: -0.0125,
        legPivots: [],
        chelipedPairs: 2,
        shell: null,
      },
    },
    zMin: -0.0125,
    zMax: 0.0125,
    instances: new FishInstanceData(1, WALKER_INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth: false,
    displays: false,
  });
}

const SHELL = { centre: [0, 0.004, -0.002], drop: 0.001 } as const;

function crabMaterial(): FishMaterial {
  return new FishMaterial({
    source: new MeshStandardMaterial(),
    assetId: 'hermit-crab',
    profile: renderProfile('hermit-crab'),
    locomotion: {
      kind: 'walk',
      rig: {
        bodyLength: 0.03,
        hinge: { y: 0.0006, z: 0.0057 },
        telsonZ: -0.0155,
        legPivots: [],
        chelipedPairs: 1,
        shell: SHELL,
      },
    },
    zMin: -0.0155,
    zMax: 0.0175,
    instances: new FishInstanceData(1, WALKER_INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth: false,
    displays: false,
  });
}

function snailMaterial(): FishMaterial {
  return new FishMaterial({
    source: new MeshStandardMaterial(),
    assetId: 'nerite-snail',
    profile: renderProfile('nerite-snail'),
    locomotion: { kind: 'glide', rig: { bodyLength: 0.02, shell: SHELL } },
    zMin: -0.0129,
    zMax: 0.0134,
    instances: new FishInstanceData(1, WALKER_INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth: false,
    displays: false,
  });
}

const FEATURES = { fins: 'coverage', iridescence: true, clearcoat: true, gills: true } as const;

const deformed = (material: FishMaterial): Node => material.deformed.position;

function readsSlot(node: Node | null, offset: number): boolean {
  let found = false;
  node?.traverse((n) => {
    const buffer = n as Node & { isBufferNode?: boolean; bufferOffset?: number };
    if (buffer.isBufferNode === true && buffer.bufferOffset === offset) found = true;
  });
  return found;
}

/** Whether `node` reads instance float `slot`, as a component of the vec4 block that holds it. */
function readsSlotComponent(node: Node | null, slot: number): boolean {
  const component = 'xyzw'[slot % 4];
  let found = false;
  node?.traverse((n) => {
    const split = n as Node & { isSplitNode?: boolean; components?: string; node?: Node };
    if (split.isSplitNode !== true || split.components !== component) return;
    const buffer = split.node as Node & { isBufferNode?: boolean; bufferOffset?: number };
    if (buffer.isBufferNode === true && buffer.bufferOffset === slot - (slot % 4)) found = true;
  });
  return found;
}

const readsTint = (node: Node | null): boolean => readsSlot(node, InstanceSlot.TintR);
const readsPale = (node: Node | null): boolean =>
  readsSlot(node, InstanceSlot.Pale - (InstanceSlot.Pale % 4));
const readsMouth = (node: Node | null): boolean => readsSlotComponent(node, InstanceSlot.Mouth);
const readsYouth = (node: Node | null): boolean => readsSlotComponent(node, InstanceSlot.Youth);

function readsAttribute(node: Node | null, name: string, type: string): boolean {
  let found = false;
  node?.traverse((n) => {
    if (!(n instanceof AttributeNode) || n.nodeType !== type) return;
    // AttributeNode only exposes its name through a builder; a test has none to hand it.
    if ((n as AttributeNode & { _attributeName?: string })._attributeName === name) found = true;
  });
  return found;
}

describe('keepsAuthoredSurface', () => {
  it('selects only the material named Eye', () => {
    expect(
      keepsAuthoredSurface(new MeshStandardMaterial({ name: AUTHORED_SURFACE_MATERIAL })),
    ).toBe(true);
    expect(keepsAuthoredSurface(new MeshStandardMaterial({ name: 'CustomMaterial' }))).toBe(false);
    expect(keepsAuthoredSurface(new MeshStandardMaterial({ name: 'eye' }))).toBe(false);
    expect(keepsAuthoredSurface(new MeshStandardMaterial())).toBe(false);
  });
});

describe('FishMaterial surface', () => {
  it('keeps the authored roughness and metalness of an eye and skips the tint', () => {
    const eye = fishMaterial(
      new MeshStandardMaterial({ name: 'Eye', roughness: 0.12, metalness: 0.3, color: 0x050505 }),
    );
    expect(eye.roughness).toBeCloseTo(0.12);
    expect(eye.metalness).toBeCloseTo(0.3);
    expect(readsTint(eye.colorNode)).toBe(false);
  });

  it('gives body materials the species roughness, no metalness and the tint', () => {
    const body = fishMaterial(
      new MeshStandardMaterial({ name: 'CustomMaterial', roughness: 0.12, metalness: 0.3 }),
    );
    expect(pleco.roughness).not.toBeCloseTo(0.12);
    expect(body.roughness).toBeCloseTo(pleco.roughness);
    expect(body.metalness).toBe(0);
    expect(readsTint(body.colorNode)).toBe(true);
  });

  it('pales the skin of a sick fish but not its eyes', () => {
    const eye = fishMaterial(new MeshStandardMaterial({ name: 'Eye', color: 0x050505 }));
    const body = fishMaterial(new MeshStandardMaterial({ name: 'CustomMaterial' }));
    expect(readsPale(eye.colorNode)).toBe(false);
    expect(readsPale(body.colorNode)).toBe(true);
  });

  it('fades a young fish from a pale, glassy body into its livery, but not its eyes', () => {
    const eye = fishMaterial(new MeshStandardMaterial({ name: 'Eye', color: 0x050505 }));
    const body = fishMaterial(new MeshStandardMaterial({ name: 'CustomMaterial' }));
    expect(readsYouth(eye.colorNode)).toBe(false);
    expect(readsYouth(body.colorNode)).toBe(true);
    expect(readsYouth(shrimpMaterial().colorNode)).toBe(true);
  });

  it('lets light through a young body of any species once fins are translucent', () => {
    const body = fishMaterial(new MeshStandardMaterial({ name: 'CustomMaterial' }), false, false, {
      ...pleco,
      finTransmission: 0,
    });
    body.setFeatures(FEATURES);
    expect(readsYouth(body.emissiveNode)).toBe(true);
    body.setFeatures({ ...FEATURES, fins: 'cutout' });
    expect(body.emissiveNode).toBeNull();
    const eye = fishMaterial(new MeshStandardMaterial({ name: 'Eye' }));
    eye.setFeatures(FEATURES);
    expect(readsYouth(eye.emissiveNode)).toBe(false);
  });

  it('holds back the iridescence of a fish whose iridophores are still forming', () => {
    const neon = fishMaterial(
      new MeshStandardMaterial({ name: 'CustomMaterial' }),
      false,
      false,
      iridescent,
    );
    neon.setFeatures(FEATURES);
    expect(readsYouth(neon.iridescenceNode)).toBe(true);
  });

  it('keeps the authored surface across feature changes', () => {
    const eye = fishMaterial(new MeshStandardMaterial({ name: 'Eye', roughness: 0.12 }));
    eye.setFeatures({ fins: 'cutout', iridescence: false, clearcoat: false, gills: false });
    expect(eye.roughness).toBeCloseTo(0.12);
    expect(readsTint(eye.colorNode)).toBe(false);
  });
});

describe('FishMaterial shader graph', () => {
  it.each([
    ['a fish with a mouth', () => fishMaterial(new MeshStandardMaterial(), true)],
    ['a fish without one', () => fishMaterial(new MeshStandardMaterial(), false)],
    ['a walker', shrimpMaterial],
    ['a crab', crabMaterial],
    ['a snail', snailMaterial],
  ])('orders every constant smoothstep edge low to high for %s', (_, make) => {
    for (const gills of [false, true]) {
      const material = make();
      material.setFeatures({ ...FEATURES, gills });
      const graphs = [
        material.deformed.position,
        material.deformed.normal,
        material.castShadowPositionNode,
        material.colorNode,
        material.opacityNode,
        material.roughnessNode,
        material.clearcoatNode,
        material.iridescenceNode,
        material.transmissionNode,
        material.emissiveNode,
      ];
      expect(graphs.flatMap(reversedSmoothsteps)).toEqual([]);
    }
  });
});

describe('FishMaterial mouth', () => {
  it('drops the jaw by the per-fish mouth opening when the mesh has a mouth weight', () => {
    const material = fishMaterial(new MeshStandardMaterial(), true);
    material.setFeatures(FEATURES);
    expect(readsMouth(deformed(material))).toBe(true);
  });

  it('costs nothing on a tier without breathing', () => {
    const material = fishMaterial(new MeshStandardMaterial(), true);
    material.setFeatures({ ...FEATURES, gills: false });
    expect(readsMouth(deformed(material))).toBe(false);
  });

  it('keeps the mouth still without a mouth weight, and reads the fin attribute as it is packed', () => {
    const still = fishMaterial(new MeshStandardMaterial(), false);
    still.setFeatures(FEATURES);
    expect(readsMouth(deformed(still))).toBe(false);
    expect(readsAttribute(deformed(still), 'fin', 'vec2')).toBe(true);
    expect(readsAttribute(still.clearcoatNode, 'fin', 'vec3')).toBe(false);

    const moving = fishMaterial(new MeshStandardMaterial(), true);
    moving.setFeatures(FEATURES);
    expect(readsAttribute(deformed(moving), 'fin', 'vec2')).toBe(false);
    expect(readsAttribute(deformed(moving), 'fin', 'vec3')).toBe(true);
    expect(readsAttribute(moving.clearcoatNode, 'fin', 'vec2')).toBe(false);
  });

  it('leaves the mouth out of the shadow pass', () => {
    const material = fishMaterial(new MeshStandardMaterial(), true);
    material.setFeatures(FEATURES);
    expect(readsMouth(material.castShadowPositionNode)).toBe(false);
  });

  it("reads a walker's legs after the shared breath block", () => {
    const shrimp = shrimpMaterial();
    shrimp.setFeatures(FEATURES);
    expect(readsSlot(deformed(shrimp), WalkerSlot.LegPhase)).toBe(true);
    expect(readsMouth(deformed(shrimp))).toBe(false);
  });
});

describe('FishMaterial shell', () => {
  const readsWithdraw = (node: Node | null): boolean =>
    readsSlotComponent(node, WalkerSlot.Withdraw);

  it('pulls a crab or a snail into its shell, shadow included', () => {
    for (const make of [crabMaterial, snailMaterial]) {
      const material = make();
      material.setFeatures(FEATURES);
      expect(readsWithdraw(deformed(material))).toBe(true);
      expect(readsWithdraw(material.castShadowPositionNode)).toBe(true);
    }
  });

  it('leaves a shrimp, which has no shell, out of it', () => {
    const shrimp = shrimpMaterial();
    shrimp.setFeatures(FEATURES);
    expect(readsWithdraw(deformed(shrimp))).toBe(false);
  });

  it("ripples a snail's foot with the stride, reading the fin attribute as the snail packs it", () => {
    const snail = snailMaterial();
    snail.setFeatures(FEATURES);
    expect(readsSlotComponent(deformed(snail), WalkerSlot.Stride)).toBe(true);
    expect(readsSlotComponent(deformed(snail), WalkerSlot.LegPhase)).toBe(true);
    expect(readsAttribute(deformed(snail), 'fin', 'vec2')).toBe(true);
    expect(readsAttribute(deformed(snail), 'fin', 'vec3')).toBe(false);
    expect(readsAttribute(snail.clearcoatNode, 'fin', 'vec3')).toBe(false);
  });

  it("reads a crab's leg slot from the fin attribute like a shrimp's", () => {
    const crab = crabMaterial();
    crab.setFeatures(FEATURES);
    expect(readsAttribute(deformed(crab), 'fin', 'vec3')).toBe(true);
    expect(readsSlot(deformed(crab), WalkerSlot.LegPhase)).toBe(true);
  });

  it('keeps disease signs and the mouth off both', () => {
    const diseaseBlock = InstanceSlot.Ich - (InstanceSlot.Ich % 4);
    for (const make of [crabMaterial, snailMaterial]) {
      const material = make();
      material.setFeatures(FEATURES);
      expect(readsSlot(material.colorNode, diseaseBlock)).toBe(false);
      expect(readsMouth(deformed(material))).toBe(false);
    }
  });
});

describe('FishMaterial disease', () => {
  const diseaseBlock = InstanceSlot.Ich - (InstanceSlot.Ich % 4);
  const readsDisease = (node: Node | null): boolean => readsSlot(node, diseaseBlock);

  it('paints the signs on body skin on every tier', () => {
    for (const features of [
      FEATURES,
      { fins: 'cutout', iridescence: false, clearcoat: false, gills: false } as const,
    ]) {
      const body = fishMaterial(new MeshStandardMaterial({ name: 'CustomMaterial' }));
      body.setFeatures(features);
      expect(readsDisease(body.colorNode)).toBe(true);
      expect(readsDisease(body.roughnessNode)).toBe(true);
    }
  });

  it('cuts rotted fin away in every fin mode', () => {
    for (const fins of ['cutout', 'coverage', 'stochastic'] as const) {
      const body = fishMaterial(new MeshStandardMaterial({ transparent: true }));
      body.setFeatures({ ...FEATURES, fins });
      const cut = body.alphaToCoverage ? body.opacityNode : body.maskNode;
      expect(readsDisease(cut)).toBe(true);
    }
    const opaque = fishMaterial(new MeshStandardMaterial());
    opaque.setFeatures({ ...FEATURES, fins: 'cutout' });
    expect(readsDisease(opaque.maskNode)).toBe(true);
  });

  it('dulls the gloss and the iridescence under velvet dust', () => {
    const body = fishMaterial(new MeshStandardMaterial(), false, false, iridescent);
    body.setFeatures(FEATURES);
    expect(readsDisease(body.clearcoatNode)).toBe(true);
    expect(readsDisease(body.iridescenceNode)).toBe(true);
  });

  it('leaves eyes and walkers as they were', () => {
    const eye = fishMaterial(new MeshStandardMaterial({ name: 'Eye', roughness: 0.12 }));
    eye.setFeatures(FEATURES);
    expect(readsDisease(eye.colorNode)).toBe(false);
    expect(eye.roughnessNode).toBeNull();
    expect(eye.maskNode).toBeNull();

    const shrimp = shrimpMaterial();
    shrimp.setFeatures(FEATURES);
    for (const node of [shrimp.colorNode, shrimp.opacityNode, shrimp.maskNode]) {
      expect(readsDisease(node)).toBe(false);
    }
    expect(shrimp.roughnessNode).toBeNull();
  });

  it('shades every fish with its normal, not only those the disease branches run for', () => {
    for (const features of [
      FEATURES,
      { fins: 'cutout', iridescence: false, clearcoat: false, gills: false } as const,
    ]) {
      const body = fishMaterial(new MeshStandardMaterial({ name: 'CustomMaterial' }));
      body.setFeatures(features);
      const geometry = new BoxGeometry(0.1, 0.03, 0.1);
      geometry.setAttribute(
        FIN_ATTRIBUTE,
        new BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2),
      );
      const mesh = new InstancedMesh(geometry, body, 1);
      const { fragment } = buildShaders(mesh, 'webgl', [new DirectionalLight()]);
      const assignments = mainBodyDepths(fragment).filter(({ line }) =>
        /^normalView\s*=/.test(line),
      );
      expect(assignments.length).toBeGreaterThan(0);
      for (const { depth } of assignments) expect(depth).toBe(0);
    }
  });
});

describe('FishMaterial display', () => {
  it.each([false, true])(
    'spreads the fins and flares the gill covers with gills %s, shadow included',
    (gills) => {
      const material = fishMaterial(new MeshStandardMaterial(), true, true);
      material.setFeatures({ ...FEATURES, gills });
      for (const graph of [deformed(material), material.castShadowPositionNode]) {
        expect(readsSlotComponent(graph, InstanceSlot.Display)).toBe(true);
        expect(readsSlotComponent(graph, InstanceSlot.GillFlare)).toBe(true);
      }
      expect(readsSlotComponent(material.deformed.normal, InstanceSlot.GillFlare)).toBe(true);
    },
  );

  it('leaves a species that never displays out of it, gill pumping and jaw included', () => {
    const material = fishMaterial(new MeshStandardMaterial(), true, false);
    material.setFeatures(FEATURES);
    for (const graph of [deformed(material), material.castShadowPositionNode]) {
      expect(readsSlotComponent(graph, InstanceSlot.Display)).toBe(false);
      expect(readsSlotComponent(graph, InstanceSlot.GillFlare)).toBe(false);
    }
    expect(readsSlotComponent(deformed(material), InstanceSlot.Gills)).toBe(true);
    expect(readsMouth(deformed(material))).toBe(true);
  });

  it('leaves a walker out of it', () => {
    const shrimp = shrimpMaterial();
    shrimp.setFeatures(FEATURES);
    expect(readsSlotComponent(deformed(shrimp), InstanceSlot.Display)).toBe(false);
    expect(readsSlotComponent(deformed(shrimp), InstanceSlot.GillFlare)).toBe(false);
  });
});

type EvalNode = Node & {
  isConstNode?: boolean;
  isVarNode?: boolean;
  isOperatorNode?: boolean;
  isMathNode?: boolean;
  value?: unknown;
  node?: Node;
  op?: string;
  method?: string;
  aNode?: Node;
  bNode?: Node | null;
  cNode?: Node | null;
};

/** Evaluates the scalar arithmetic `finDisplay` builds, so its geometry can be checked on the CPU. */
function evaluate(node: Node | null | undefined): number {
  const n = node as EvalNode | null | undefined;
  if (n == null) throw new Error('missing operand');
  if (n.isConstNode === true && typeof n.value === 'number') return n.value;
  if (n.isVarNode === true) return evaluate(n.node);
  const a = (): number => evaluate(n.aNode);
  const b = (): number => evaluate(n.bNode);
  const c = (): number => evaluate(n.cNode);
  if (n.isOperatorNode === true) {
    switch (n.op) {
      case '+':
        return a() + b();
      case '-':
        return a() - b();
      case '*':
        return a() * b();
      case '/':
        return a() / b();
    }
  }
  if (n.isMathNode === true) {
    switch (n.method) {
      case 'cos':
        return Math.cos(a());
      case 'sin':
        return Math.sin(a());
      case 'atan':
        return n.bNode == null ? Math.atan(a()) : Math.atan2(a(), b());
      case 'max':
        return Math.max(a(), b());
      case 'negate':
        return -a();
      case 'step':
        return b() >= a() ? 1 : 0;
      case 'smoothstep': {
        const t = Math.min(Math.max((c() - a()) / (b() - a()), 0), 1);
        return t * t * (3 - 2 * t);
      }
    }
  }
  throw new Error(`cannot evaluate ${n.type} ${n.op ?? n.method ?? ''}`);
}

describe('finDisplay geometry', () => {
  const zMax = 0.0365;
  const zLen = 0.073;
  const zAt = (s: number): number => zMax - s * zLen;
  const fins = {
    dorsal: { isDorsal: 1, isAnal: 0, isCaudal: 0, pivotS: 0.4 },
    anal: { isDorsal: 0, isAnal: 1, isCaudal: 0, pivotS: 0.3 },
    caudal: { isDorsal: 0, isAnal: 0, isCaudal: 1, pivotS: 0.65 },
  } as const;
  type FinName = keyof typeof fins;

  function at(fin: FinName, y: number, z: number, mask: number, display: number) {
    const { isDorsal, isAnal, isCaudal } = fins[fin];
    const out = finDisplay({
      y: float(y),
      z: float(z),
      mask: float(mask),
      display: float(display),
      isDorsal: float(isDorsal),
      isAnal: float(isAnal),
      isCaudal: float(isCaudal),
      zMax,
      zLen,
    });
    return { y: evaluate(out.y), z: evaluate(out.z) };
  }

  it.each(Object.keys(fins) as FinName[])('keeps the %s root where it is', (fin) => {
    const z = zAt(fins[fin].pivotS + 0.1);
    const moved = at(fin, 0.004, z, 0, 1);
    expect(moved.y).toBeCloseTo(0.004, 9);
    expect(moved.z).toBeCloseTo(z, 9);
  });

  it('raises the dorsal edge, lowers the anal edge and lifts the tail, stretched outwards', () => {
    const dorsal = at('dorsal', 0.01, zAt(0.6), 1, 1);
    expect(dorsal.y).toBeGreaterThan(0.01);
    const anal = at('anal', -0.01, zAt(0.55), 1, 1);
    expect(anal.y).toBeLessThan(-0.01);
    const tail = at('caudal', 0, zAt(0.95), 1, 1);
    expect(tail.y).toBeGreaterThan(0);
    const pivot = zAt(0.65);
    expect(Math.hypot(tail.y, tail.z - pivot)).toBeGreaterThan(Math.abs(zAt(0.95) - pivot));
  });

  it.each([
    ['dorsal', 0.006, 0.18],
    ['dorsal', 0.006, 0.39],
    ['anal', -0.005, 0.2],
    ['caudal', 0.0004, 0.62],
    ['caudal', -0.0004, 0.62],
    ['caudal', 0, 0.65],
  ] as const)('leaves a %s ray at y %f ahead of its pivot (s %f) in place', (fin, y, s) => {
    const moved = at(fin, y, zAt(s), 1, 1);
    expect(Number.isFinite(moved.y) && Number.isFinite(moved.z)).toBe(true);
    expect(moved.y).toBeCloseTo(y, 9);
    expect(moved.z).toBeCloseTo(zAt(s), 9);
  });

  it('fans the tail continuously across its axis', () => {
    const z = zAt(0.7);
    const above = at('caudal', 1e-5, z, 1, 1);
    const below = at('caudal', -1e-5, z, 1, 1);
    expect(Math.hypot(above.y - below.y, above.z - below.z)).toBeLessThan(1e-4);
  });

  it('moves no fin vertex further than the stretched turn allows at full display', () => {
    for (const fin of Object.keys(fins) as FinName[]) {
      const pivot = zAt(fins[fin].pivotS);
      for (let s = 0; s <= 1; s += 0.05) {
        for (const y of [-0.012, -0.004, 0, 0.004, 0.012]) {
          const z = zAt(s);
          const moved = at(fin, y, z, 1, 1);
          const reach = Math.hypot(y, z - pivot);
          expect(Number.isFinite(moved.y) && Number.isFinite(moved.z)).toBe(true);
          expect(Math.hypot(moved.y, moved.z - pivot)).toBeLessThanOrEqual(reach * 1.12 + 1e-12);
          if (z >= pivot) {
            expect(moved.y).toBeCloseTo(y, 12);
            expect(moved.z).toBeCloseTo(z, 12);
          }
        }
      }
    }
  });
});
