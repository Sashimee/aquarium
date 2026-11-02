import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { DecorItem } from '@aquarium/shared';
import { AssetCatalog, type CatalogEntry, type LoadedModel } from './assets';
import { createCoralGlowNode, decorMatrix, Hardscape, HARDSCAPE_KINDS } from './hardscape';
import { parseEuphylliaId } from './euphyllia';
import { loadPreset } from './preset';

const glow = createCoralGlowNode(uniform(0));
let catalog: AssetCatalog;

beforeAll(async () => {
  const path = join(__dirname, '../../public/assets/index.json');
  const index = JSON.parse(await readFile(path, 'utf8')) as {
    assets: ConstructorParameters<typeof AssetCatalog>[0];
  };
  catalog = new AssetCatalog(index.assets);
});

function fakeModel(primitives = 1): LoadedModel {
  return {
    primitives: Array.from({ length: primitives }, () => ({
      geometry: new BoxGeometry(),
      material: new MeshStandardMaterial(),
    })),
  };
}

function build(biome: 'blackwater' | 'reef') {
  const preset = loadPreset(biome);
  const hardscape = new Hardscape(biome, glow, uniform(0));
  const models = new Map<string, LoadedModel>();
  const items: DecorItem[] = [];
  for (const item of preset.decor) {
    if (parseEuphylliaId(item.assetId)) continue;
    const entry = catalog.get(item.assetId);
    if (!HARDSCAPE_KINDS.has(entry.kind)) continue;
    let model = models.get(item.assetId);
    if (!model) {
      model = fakeModel();
      models.set(item.assetId, model);
    }
    hardscape.add(entry, model, item);
    items.push(item);
  }
  return { hardscape, items };
}

const isCoral = (item: DecorItem) => catalog.get(item.assetId).kind === 'coral';

function expectMatrix(actual: number[], expected: Matrix4): void {
  expected.elements.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 5));
}

describe('Hardscape instancing', () => {
  it('collapses the repeated catappa leaves of the blackwater preset into one draw', () => {
    const { hardscape, items } = build('blackwater');
    const leaves = items.filter((i) => i.assetId === 'catappa-leaf-card');
    expect(leaves.length).toBeGreaterThanOrEqual(12);
    const meshes = hardscape.group.children as Mesh[];
    const leafMeshes = meshes.filter((m) => m.name.startsWith('catappa-leaf-card'));
    expect(leafMeshes).toHaveLength(1);
    expect((leafMeshes[0] as InstancedMesh).count).toBe(leaves.length);
    const distinct = new Set(items.filter((i) => !isCoral(i)).map((i) => i.assetId)).size;
    expect(meshes).toHaveLength(distinct + items.filter(isCoral).length);
    expect(meshes.length).toBeLessThan(items.length);
  });

  it('keeps every instance at its own item transform and follows setItem', () => {
    const { hardscape, items } = build('blackwater');
    const index = items.findIndex((i) => i.assetId === 'catappa-leaf-card');
    const batch = (hardscape.group.children as Mesh[]).find((m) =>
      m.name.startsWith('catappa-leaf-card'),
    ) as InstancedMesh;
    const leaves = items.filter((i) => i.assetId === 'catappa-leaf-card');
    const read = (slot: number) => {
      const m = new Matrix4();
      batch.getMatrixAt(slot, m);
      return Array.from(m.elements);
    };
    leaves.forEach((leaf, slot) => {
      expectMatrix(read(slot), decorMatrix(leaf));
    });
    const [first, second] = leaves;
    if (!first || !second) throw new Error('blackwater preset has fewer than two catappa leaves');
    const moved: DecorItem = { ...first, position: [0.1, 0.2, 0.3], rotationY: 0.5 };
    hardscape.setItem(index, moved);
    expectMatrix(read(0), decorMatrix(moved));
    expectMatrix(read(1), decorMatrix(second));
  });

  it('draws one mesh per primitive however many items share the asset', () => {
    const hardscape = new Hardscape('freshwater', glow, uniform(0));
    const entry: CatalogEntry = { id: 'rock-a', kind: 'rock', lods: [{ file: 'x.glb' }] };
    const model = fakeModel(3);
    for (let i = 0; i < 9; i++) {
      const item = { assetId: 'rock-a', position: [i, 0, 0], rotationY: 0, scale: 1 } as DecorItem;
      hardscape.add(entry, model, item);
    }
    expect(hardscape.group.children).toHaveLength(3);
    for (const mesh of hardscape.group.children as InstancedMesh[]) expect(mesh.count).toBe(9);
  });

  it('keeps coral as one mesh per item so each can tint and bleach alone', () => {
    const { hardscape, items } = build('reef');
    const corals = items.filter(isCoral);
    const individual = (hardscape.group.children as Mesh[]).filter(
      (m) => !(m as Partial<InstancedMesh>).isInstancedMesh,
    );
    expect(individual).toHaveLength(corals.length);
  });
});
