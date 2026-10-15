import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, Vector3, type Node } from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { FishInstanceData, INSTANCE_STRIDE, InstanceSlot } from './instances';
import { AUTHORED_SURFACE_MATERIAL, FishMaterial, keepsAuthoredSurface } from './material';
import { renderProfile } from './profiles';
import { SWIM_MODES } from './swim';

const pleco = renderProfile('bristlenose-pleco');

function fishMaterial(source: MeshStandardMaterial): FishMaterial {
  return new FishMaterial({
    source,
    assetId: 'bristlenose-pleco',
    profile: pleco,
    locomotion: { kind: 'swim', mode: SWIM_MODES.carangiform },
    zMin: -0.05,
    zMax: 0.05,
    instances: new FishInstanceData(1, INSTANCE_STRIDE),
    lighting: { lightDirection: uniform(new Vector3(0, 1, 0)), light: vec3(1) },
  });
}

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
