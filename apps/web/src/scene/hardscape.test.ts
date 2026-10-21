import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Texture,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import type { CatalogEntry, LoadedModel } from './assets';
import { createCoralGlowNode, Hardscape } from './hardscape';

const entry: CatalogEntry = { id: 'brain-coral', kind: 'coral', lods: [{ file: 'x.glb' }] };

function item(assetId: string, x: number): DecorItem {
  return { assetId, position: [x, 0, 0.3], rotationY: x, scale: 1 } as DecorItem;
}

function sourceMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7, metalness: 0.1 });
  material.name = 'tissue';
  material.map = new Texture();
  material.metalnessMap = new Texture();
  material.aoMapIntensity = 0.6;
  material.side = DoubleSide;
  material.vertexColors = true;
  material.alphaTest = 0.4;
  return material;
}

function model(material = sourceMaterial()): LoadedModel {
  return { primitives: [{ geometry: new BoxGeometry(), material }] };
}

function materialOf(hardscape: Hardscape, index: number): MeshStandardMaterial {
  return (hardscape.group.children[index] as Mesh).material as MeshStandardMaterial;
}

describe('Hardscape.add', () => {
  const glow = createCoralGlowNode(uniform(0));

  it('gives reef corals a node material that carries the source properties over', () => {
    const source = sourceMaterial();
    const hardscape = new Hardscape('reef', glow, uniform(0));
    hardscape.add(entry, model(source), item('brain-coral', 0));
    const material = materialOf(hardscape, 0);
    if (!(material instanceof MeshStandardNodeMaterial))
      throw new Error('expected a node material');
    expect(material.emissiveNode).toBe(glow);
    expect(material.name).toBe('tissue');
    expect(material.map).toBe(source.map);
    expect(material.metalnessMap).toBe(source.metalnessMap);
    expect(material.aoMapIntensity).toBe(0.6);
    expect(material.roughness).toBe(0.7);
    expect(material.side).toBe(DoubleSide);
    expect(material.vertexColors).toBe(true);
    expect(material.alphaTest).toBe(0.4);
    expect(material.emissive.getHex()).not.toBe(0);
    expect(material.color.getHex()).not.toBe(new Color(0xcccccc).getHex());
  });

  it('shares one emissive graph, so every coral has the same program cache key', () => {
    const hardscape = new Hardscape('reef', glow, uniform(0));
    for (let i = 0; i < 6; i++) hardscape.add(entry, model(), item('brain-coral', i));
    const materials = hardscape.group.children.map(
      (child) => (child as Mesh).material as MeshStandardNodeMaterial,
    );
    expect(new Set(materials.map((m) => m.customProgramCacheKey())).size).toBe(1);
    expect(new Set(materials.map((m) => m.emissive.getHex())).size).toBeGreaterThan(1);
  });

  it('would not share a key if each coral built its own graph (the cost this avoids)', () => {
    const level = uniform(0);
    const keys = new Set<number | string>();
    for (let i = 0; i < 6; i++) {
      const material = new MeshStandardNodeMaterial();
      material.emissiveNode = createCoralGlowNode(level);
      keys.add(material.customProgramCacheKey());
    }
    expect(keys.size).toBe(6);
  });

  it('keeps a plain tinted clone in freshwater', () => {
    const source = sourceMaterial();
    const hardscape = new Hardscape('freshwater', glow, uniform(0));
    hardscape.add(entry, model(source), item('brain-coral', 0));
    const material = materialOf(hardscape, 0);
    expect(material).not.toBeInstanceOf(MeshStandardNodeMaterial);
    expect(material.map).toBe(source.map);
    expect(material.emissive.getHex()).toBe(0);
  });

  it('leaves untinted decor on the shared source material', () => {
    const source = sourceMaterial();
    const hardscape = new Hardscape('reef', glow, uniform(0));
    hardscape.add({ ...entry, id: 'rock-a', kind: 'rock' }, model(source), item('rock-a', 0));
    expect(materialOf(hardscape, 0)).toBe(source);
  });
});
