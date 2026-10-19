import { describe, expect, it } from 'vitest';
import { Texture, Vector3, type Node } from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { ImpostorInstanceData, ImpostorSlot } from './impostor';
import { FishImpostorMaterial } from './impostorMaterial';
import type { FishMaterialFeatures } from './material';
import { renderProfile } from './profiles';
import { SWIM_MODES } from './swim';

const profile = renderProfile('neon-tetra');

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
      albedo: new Texture(),
      normal: new Texture(),
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
