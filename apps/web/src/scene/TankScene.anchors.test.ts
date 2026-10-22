import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecorItem } from '@aquarium/shared';
import type { Engine } from '../engine/Engine';
import type { SceneAnchor } from './anemone';
import { TankScene } from './TankScene';
import { fakeEngine, preset } from './tankSceneHarness';

const PUBLIC = join(__dirname, '../../public');

const releasers: ReturnType<typeof setInterval>[] = [];

afterEach(() => {
  for (const release of releasers.splice(0)) clearInterval(release);
  vi.unstubAllGlobals();
});

const arch: DecorItem = { assetId: 'reef-arch', position: [0, 0.05, 0], rotationY: 0, scale: 1 };

async function builtScene() {
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
  const h = fakeEngine();
  const quality = h.engine.quality as unknown as {
    register: (name: string, apply: (settings: unknown, tier: unknown) => void) => () => void;
    settings: unknown;
    tier: unknown;
  };
  quality.register = (_name, apply) => {
    apply(quality.settings, quality.tier);
    return () => undefined;
  };
  const building = TankScene.create(
    h.engine as Engine,
    { ...preset, substrate: { assetId: 'reef-sand', tint: [1, 1, 1], tileMeters: 0.4 } },
    { colliders: false },
    new AbortController().signal,
  );
  const release = setInterval(() => h.ktx2.releaseAll(), 1);
  releasers.push(release);
  return building;
}

describe('TankScene cave anchors through setHardDecor', () => {
  it('tell a listener the anchors for a placed, a moved and a removed shelter', async () => {
    const scene = await builtScene();
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
