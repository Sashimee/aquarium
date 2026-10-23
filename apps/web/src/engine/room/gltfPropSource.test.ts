import {
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSharedKtx2 } from '../ktx2';
import { GltfPropSource, propFilesFrom, roomPropMaterial } from './gltfPropSource';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('roomPropMaterial', () => {
  it('moves a glTF material, maps and all, onto a node twin the room lights', () => {
    const map = new Texture();
    const normalMap = new Texture();
    const source = new MeshStandardMaterial({
      name: 'leather',
      color: 0x804020,
      roughness: 0.7,
      metalness: 0.1,
      map,
      normalMap,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
    });
    const freed = vi.spyOn(source, 'dispose');
    const twin = roomPropMaterial(source);
    expect(twin).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(twin.name).toBe('room-prop-leather');
    expect(twin.color.getHex()).toBe(0x804020);
    expect(twin).toMatchObject({ roughness: 0.7, metalness: 0.1, opacity: 0.5, transparent: true });
    expect(twin.side).toBe(DoubleSide);
    expect(twin.map).toBe(map);
    expect(twin.normalMap).toBe(normalMap);
    expect(freed).toHaveBeenCalled();
  });

  it('names an unnamed material, and refuses one that is not PBR', () => {
    expect(roomPropMaterial(new MeshStandardMaterial()).name).toBe('room-prop-material');
    expect(() => roomPropMaterial(new MeshBasicMaterial({ name: 'flat' }))).toThrow(
      'expected a glTF PBR material',
    );
  });
});

describe('roomPropMaterial warnings', () => {
  it('warns about glass, envMapIntensity and alphaHash, which the twin drops', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    roomPropMaterial(new MeshPhysicalMaterial({ name: 'glass', transmission: 1 }));
    roomPropMaterial(new MeshStandardMaterial({ name: 'dim', envMapIntensity: 0.5 }));
    roomPropMaterial(new MeshStandardMaterial({ name: 'leaf', alphaHash: true }));
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      'Room prop material "glass" drops transmission (glass)',
      'Room prop material "dim" drops envMapIntensity',
      'Room prop material "leaf" drops alphaHash',
    ]);
  });

  it('stays quiet for a plain PBR material, physical or not', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    roomPropMaterial(new MeshStandardMaterial({ name: 'wood' }));
    roomPropMaterial(new MeshPhysicalMaterial({ name: 'lacquer', clearcoat: 0 }));
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('GltfPropSource', () => {
  const renderer = { isWebGPURenderer: true, hasFeature: () => false } as unknown as WebGPURenderer;
  const files = propFilesFrom([
    { id: 'sofa', kind: 'room-furniture', lods: [{ file: 'room-furniture/sofa/lod0.glb' }] },
  ]);

  function stubFetch(respond: (signal: AbortSignal | undefined) => Promise<Response>) {
    const requests: { url: string; signal: AbortSignal | undefined }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      requests.push({ url, signal });
      return respond(signal);
    });
    return requests;
  }

  it('stops downloading a prop when its room is abandoned', async () => {
    const requests = stubFetch(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    );
    const { loader, dispose } = createSharedKtx2(renderer);
    const source = new GltfPropSource(loader, files);
    const controller = new AbortController();
    const load = source.load('sofa', 0, controller.signal);
    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toMatch(/room-furniture\/sofa\/lod0\.glb$/);
    expect(requests[0]?.signal?.aborted).toBe(true);
    dispose();
  });

  it('does not parse a GLB, or fetch its textures, once the room was abandoned', async () => {
    const controller = new AbortController();
    const requests = stubFetch(async () => {
      controller.abort();
      return new Response(new Uint8Array(4));
    });
    const { loader, dispose } = createSharedKtx2(renderer);
    const parse = vi.spyOn(GLTFLoader.prototype, 'parseAsync');
    const source = new GltfPropSource(loader, files);
    await expect(source.load('sofa', 0, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(parse).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    dispose();
  });

  it('names the prop and the status of a failed download', async () => {
    stubFetch(async () => new Response(null, { status: 404 }));
    const { loader, dispose } = createSharedKtx2(renderer);
    const source = new GltfPropSource(loader, files);
    await expect(source.load('sofa', 0)).rejects.toThrow(
      /Room prop .*room-furniture\/sofa\/lod0\.glb returned HTTP 404/,
    );
    dispose();
  });
});

describe('propFilesFrom', () => {
  const files = propFilesFrom([
    { id: 'chair', kind: 'room-furniture', lods: [{ file: 'chair/lod0.glb' }] },
    { id: 'fish', kind: 'fish', lods: [{ file: 'fish/lod0.glb' }] },
  ]);

  it('finds a prop GLB at a LOD', () => {
    expect(files('chair', 0)).toBe('chair/lod0.glb');
  });

  it('refuses an unknown prop, a non-furniture asset or a missing LOD', () => {
    expect(() => files('sofa', 0)).toThrow('Unknown room prop "sofa"');
    expect(() => files('fish', 0)).toThrow('Unknown room prop "fish"');
    expect(() => files('chair', 2)).toThrow('has no LOD 2');
  });
});
