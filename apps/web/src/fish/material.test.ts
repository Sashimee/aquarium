import { describe, expect, it } from 'vitest';
import {
  AttributeNode,
  ConstNode,
  MathNode,
  MeshStandardMaterial,
  Vector3,
  type Node,
} from 'three/webgpu';
import { float, smoothstep, uniform, vec3 } from 'three/tsl';
import {
  FishInstanceData,
  INSTANCE_STRIDE,
  InstanceSlot,
  WALKER_INSTANCE_STRIDE,
  WalkerSlot,
} from './instances';
import { AUTHORED_SURFACE_MATERIAL, FishMaterial, keepsAuthoredSurface } from './material';
import { renderProfile } from './profiles';
import { SWIM_MODES } from './swim';

const pleco = renderProfile('bristlenose-pleco');

function fishMaterial(source: MeshStandardMaterial, mouth = false): FishMaterial {
  return new FishMaterial({
    source,
    assetId: 'bristlenose-pleco',
    profile: pleco,
    locomotion: { kind: 'swim', mode: SWIM_MODES.carangiform },
    zMin: -0.05,
    zMax: 0.05,
    instances: new FishInstanceData(1, INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth,
  });
}

function shrimpMaterial(): FishMaterial {
  return new FishMaterial({
    source: new MeshStandardMaterial(),
    assetId: 'cherry-shrimp',
    profile: renderProfile('cherry-shrimp'),
    locomotion: {
      kind: 'walk',
      rig: { bodyLength: 0.025, hinge: { y: 0, z: 0 }, telsonZ: -0.0125, legPivots: [] },
    },
    zMin: -0.0125,
    zMax: 0.0125,
    instances: new FishInstanceData(1, WALKER_INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
    mouth: false,
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

const readsTint = (node: Node | null): boolean => readsSlot(node, InstanceSlot.TintR);
const readsPale = (node: Node | null): boolean =>
  readsSlot(node, InstanceSlot.Pale - (InstanceSlot.Pale % 4));
const readsMouth = (node: Node | null): boolean => readsSlot(node, InstanceSlot.Mouth);

function readsAttribute(node: Node | null, name: string, type: string): boolean {
  let found = false;
  node?.traverse((n) => {
    if (!(n instanceof AttributeNode) || n.nodeType !== type) return;
    // AttributeNode only exposes its name through a builder; a test has none to hand it.
    if ((n as AttributeNode & { _attributeName?: string })._attributeName === name) found = true;
  });
  return found;
}

const constant = (node: Node | null): number | null =>
  node instanceof ConstNode && typeof node.value === 'number' ? node.value : null;

/** smoothstep with edge0 >= edge1 is undefined in GLSL ES 3.00 and MSL. */
function reversedSmoothsteps(node: Node | null): string[] {
  const found: string[] = [];
  node?.traverse((n) => {
    if (!(n instanceof MathNode) || n.method !== MathNode.SMOOTHSTEP) return;
    const low = constant(n.aNode);
    const high = constant(n.bNode);
    if (low !== null && high !== null && low >= high) found.push(`smoothstep(${low}, ${high}, x)`);
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

  it('catches a smoothstep written high to low', () => {
    expect(reversedSmoothsteps(smoothstep(0.2, 0, float(0.1)))).toEqual(['smoothstep(0.2, 0, x)']);
    expect(reversedSmoothsteps(smoothstep(0, 0.2, float(0.1)))).toEqual([]);
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
