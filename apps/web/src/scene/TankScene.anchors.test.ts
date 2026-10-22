import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecorItem } from '@aquarium/shared';
import { TankScene } from './TankScene';
import { fakeEngine, preset, stubCatalog } from './tankSceneHarness';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Internals {
  hardItems: { item: DecorItem; kind: string }[];
}

const arch: DecorItem = { assetId: 'reef-arch', position: [0, 0.05, 0], rotationY: 0, scale: 1 };

async function builtScene() {
  stubCatalog();
  const h = fakeEngine();
  const building = TankScene.create(
    h.engine,
    preset,
    { colliders: false },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(h.ktx2.pending.length).toBeGreaterThan(0));
  while (h.ktx2.pending.length > 0) {
    h.ktx2.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return building;
}

describe('TankScene cave anchors', () => {
  it('follow the hard decor currently placed, not the preset it started with', async () => {
    const scene = await builtScene();
    const internals = scene as unknown as Internals;
    const caves = () => scene.anchors.filter((a) => a.kind === 'cave');
    expect(caves()).toEqual([]);

    internals.hardItems = [{ item: arch, kind: 'rock' }];
    expect(caves()).toHaveLength(1);

    internals.hardItems = [{ item: { ...arch, position: [0.3, 0.05, 0.1] }, kind: 'rock' }];
    expect(caves()[0]?.position[0]).toBeGreaterThan(0.25);

    internals.hardItems = [];
    expect(caves()).toEqual([]);
    await scene.dispose();
  });
});
