import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecorItem, PresetLayout } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { SceneAnchor } from './anemone';
import { ModelLibrary } from './assets';
import { TankScene } from './TankScene';
import { BANK_CLEARANCE } from './bank';
import { MUD_BANK_FLAT, MUD_BANK_ID } from './mudBank';
import { loadPreset } from './preset';
import { fakeEngine, preset } from './tankSceneHarness';

const PUBLIC = join(__dirname, '../../public');

const releasers: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const release of releasers.splice(0)) clearInterval(release);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const reefLayout: PresetLayout = {
  ...preset,
  substrate: { assetId: 'reef-sand', tint: [1, 1, 1], tileMeters: 0.4 },
};

const arch: DecorItem = { assetId: 'reef-arch', position: [0, 0.05, 0], rotationY: 0, scale: 1 };

async function builtScene(layout: PresetLayout = reefLayout) {
  vi.stubGlobal('ProgressEvent', Event);
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal(
    'Request',
    class {
      constructor(readonly url: string) {}
    },
  );
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
    const bytes = await readFile(join(PUBLIC, new URL(url, 'http://x').pathname));
    return new Response(new Uint8Array(bytes));
  });
  const h = fakeEngine({ applyOnRegister: true });
  const building = TankScene.create(
    h.engine as Engine,
    layout,
    { colliders: false },
    new AbortController().signal,
  );
  const release = setInterval(() => h.ktx2.releaseAll(), 1);
  releasers.push(release);
  return { scene: await building, h };
}

describe('TankScene cave anchors through setHardDecor', () => {
  it('tell a listener the anchors for a placed, a moved and a removed shelter', async () => {
    const { scene } = await builtScene();
    const heard: (readonly SceneAnchor[])[] = [];
    const off = scene.onAnchorsChanged((anchors) => heard.push(anchors));
    const caves = (anchors: readonly SceneAnchor[]) => anchors.filter((a) => a.kind === 'cave');

    await scene.setHardDecor([arch]);
    expect(heard).toHaveLength(1);
    expect(caves(heard[0] ?? [])).toHaveLength(1);
    expect(caves(scene.anchors)).toHaveLength(1);

    await scene.setHardDecor([{ ...arch, position: [0.3, 0.05, 0.1] }]);
    expect(heard).toHaveLength(2);
    expect(caves(heard[1] ?? [])[0]?.position[0]).toBeGreaterThan(0.25);

    await scene.setHardDecor([]);
    expect(heard).toHaveLength(3);
    expect(caves(heard[2] ?? [])).toEqual([]);

    off();
    await scene.setHardDecor([arch]);
    expect(heard).toHaveLength(3);
    await scene.dispose();
  }, 30_000);
});

describe('TankScene anchor notification ordering', () => {
  it('evicts unused models before telling listeners', async () => {
    const { scene } = await builtScene();
    const order: string[] = [];
    vi.spyOn(ModelLibrary.prototype, 'retainOnly').mockImplementation(
      async () => void order.push('evict'),
    );
    scene.onAnchorsChanged(() => order.push('notify'));
    await scene.setHardDecor([arch]);
    expect(order).toEqual(['evict', 'notify']);
    await scene.dispose();
  }, 30_000);

  it('still evicts and reaches later listeners when one listener throws', async () => {
    const { scene, h } = await builtScene();
    const retain = vi.spyOn(ModelLibrary.prototype, 'retainOnly');
    const heard: number[] = [];
    scene.onAnchorsChanged(() => {
      throw new Error('listener boom');
    });
    scene.onAnchorsChanged((anchors) => heard.push(anchors.length));
    h.errors.length = 0;
    await scene.setHardDecor([arch]);
    expect(retain).toHaveBeenCalled();
    expect(heard).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({ message: 'An anchor listener threw' });
    await scene.dispose();
  }, 30_000);

  it('still tells listeners about the applied layout when eviction throws', async () => {
    const { scene, h } = await builtScene();
    vi.spyOn(ModelLibrary.prototype, 'retainOnly').mockRejectedValue(new Error('evict boom'));
    const heard: (readonly SceneAnchor[])[] = [];
    scene.onAnchorsChanged((anchors) => heard.push(anchors));
    h.errors.length = 0;
    await scene.setHardDecor([arch]);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.some((a) => a.kind === 'cave')).toBe(true);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatchObject({
      cause: expect.objectContaining({ message: 'evict boom' }),
    });
    await scene.dispose();
  }, 30_000);
});

describe('TankScene mud bank', () => {
  it('draws the bank, collides with it, offers it as a bank anchor and removes it on dispose', async () => {
    const { scene, h } = await builtScene(loadPreset('mangrove'));
    const waterTop = scene.waterTop;
    const meshes = h.engine.scene.children.filter((o) => o.name === MUD_BANK_ID);
    expect(meshes).toHaveLength(1);
    const banks = scene.banks.filter((b) => b.radius >= MUD_BANK_FLAT.z);
    expect(banks).toHaveLength(1);
    expect(banks[0]?.position[1]).toBeGreaterThanOrEqual(waterTop + BANK_CLEARANCE);
    const [x, y, z] = banks[0]?.position ?? [0, 0, 0];
    const covering = scene.colliderList.filter(
      (c) =>
        c.kind === 'hull' &&
        Math.hypot(c.centre[0] - x, c.centre[2] - z) < c.boundRadius &&
        c.centre[1] < y,
    );
    expect(covering.length).toBeGreaterThanOrEqual(3);
    expect(scene.colliders.hard(x, y - 0.01, z, new Float64Array(3))).toBeLessThan(0);
    expect(scene.fixedDecor.some((i) => i.assetId === MUD_BANK_ID)).toBe(true);
    await scene.dispose();
    expect(h.engine.scene.children.filter((o) => o.name === MUD_BANK_ID)).toHaveLength(0);
  }, 60_000);
});
