import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  Vector4,
} from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createInertRenderer } from './inertRenderer';
import { shadowRegion, TierShadow } from './tierShadow';

const CAPACITY = 2048;

async function litTank() {
  const inert = await createInertRenderer();
  const scene = new Scene();
  const light = new DirectionalLight();
  light.position.set(0, 4, 1);
  light.shadow.intensity = 0.8;
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(light, mesh);
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const tiers = new TierShadow(light, CAPACITY);
  const frame = () => {
    inert.nextFrame();
    inert.renderer.render(scene, camera);
  };
  const shadowViewports = () =>
    inert.passes
      .filter((p) => p.renderTarget !== null && p.renderTarget === light.shadow.map)
      .map((p) => p.viewport?.toArray());
  return { ...inert, light, tiers, frame, shadowViewports };
}

/** Where the rasteriser puts a point in the shadow pass, in three's top-left texel space. */
function drawnTexel(light: DirectionalLight, viewport: Vector4, point: Vector3): [number, number] {
  const ndc = point.clone().project(light.shadow.camera);
  return [viewport.x + ((ndc.x + 1) / 2) * viewport.z, viewport.y + ((1 - ndc.y) / 2) * viewport.w];
}

/** Where the lit pass samples that point: ShadowNode reads the matrix's (x, 1 - y). */
function sampledTexel(light: DirectionalLight, point: Vector3): [number, number] {
  const coord = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(light.shadow.matrix);
  return [(coord.x / coord.w) * CAPACITY, (1 - coord.y / coord.w) * CAPACITY];
}

describe('shadowRegion', () => {
  it('fills the whole map at its own size', () => {
    const { viewport, scale } = shadowRegion(2048, 2048);
    expect(viewport.toArray()).toEqual([0, 0, 2048, 2048]);
    expect(scale.elements).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('puts a smaller shadow in the bottom-left corner and scales x and y alike', () => {
    const { viewport, scale } = shadowRegion(1024, 2048);
    expect(viewport.toArray()).toEqual([0, 1024, 1024, 1024]);
    expect(scale.elements).toEqual([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it.each([0, -1, 2049, Number.NaN])('rejects a size of %s', (size) => {
    expect(() => shadowRegion(size, 2048)).toThrow(RangeError);
  });
});

describe('TierShadow', () => {
  it('rejects a capacity that holds nothing and a size beyond it', () => {
    expect(() => new TierShadow(new DirectionalLight(), 0)).toThrow(RangeError);
    const tiers = new TierShadow(new DirectionalLight(), 1024);
    expect(() => tiers.apply(2048)).toThrow(RangeError);
  });

  it('only records the cast flag while three has not allocated the map', () => {
    const light = new DirectionalLight();
    const tiers = new TierShadow(light, CAPACITY);
    tiers.apply(0);
    expect(light.castShadow).toBe(false);
    tiers.apply(1024);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.mapSize.toArray()).toEqual([CAPACITY, CAPACITY]);
    expect(light.shadow.map).toBeNull();
  });

  it('draws each tier at its own size in one map that is never freed', async () => {
    const { light, tiers, frame, shadowViewports } = await litTank();
    tiers.apply(2048);
    frame();
    const map = light.shadow.map;
    if (map === null) throw new Error('three did not allocate the shadow map');
    const freed: string[] = [];
    map.addEventListener('dispose', () => freed.push('map'));
    map.depthTexture?.addEventListener('dispose', () => freed.push('depth'));

    for (const size of [1024, 512, 0, 2048, 1024]) {
      tiers.apply(size);
      frame();
    }

    expect(freed).toEqual([]);
    expect(light.shadow.map).toBe(map);
    expect([map.width, map.height]).toEqual([CAPACITY, CAPACITY]);
    expect(shadowViewports()).toEqual([
      [0, 0, 2048, 2048],
      [0, 1024, 1024, 1024],
      [0, 1536, 512, 512],
      [0, 0, 2048, 2048],
      [0, 1024, 1024, 1024],
    ]);
  });

  it.each([2048, 1024, 512])('samples a %s shadow where it drew it', async (size) => {
    const { light, tiers, frame, passes } = await litTank();
    tiers.apply(size);
    frame();
    frame();
    const pass = passes.findLast((p) => p.renderTarget === light.shadow.map);
    if (pass?.viewport == null) throw new Error('the shadow pass set no viewport');

    for (const point of [
      new Vector3(0, 0, 0),
      new Vector3(0.4, 0.5, -0.3),
      new Vector3(-2, 0, 1),
    ]) {
      const [x, y] = sampledTexel(light, point);
      const [px, py] = drawnTexel(light, pass.viewport, point);
      expect(x).toBeCloseTo(px, 6);
      expect(y).toBeCloseTo(py, 6);
    }
  });

  it('stops drawing and fades out the allocated map on a tier without shadows', async () => {
    const { light, tiers, frame, shadowViewports } = await litTank();
    tiers.apply(1024);
    frame();

    tiers.apply(0);
    frame();
    expect(light.shadow.autoUpdate).toBe(false);
    expect(light.shadow.intensity).toBe(0);
    expect(light.castShadow).toBe(true);
    expect(shadowViewports()).toHaveLength(1);
  });

  it('draws the map again, at once, when shadows come back', async () => {
    const { light, tiers, frame, shadowViewports } = await litTank();
    tiers.apply(2048);
    frame();
    tiers.apply(0);
    frame();

    tiers.apply(512);
    expect(light.shadow.autoUpdate).toBe(true);
    expect(light.shadow.needsUpdate).toBe(true);
    expect(light.shadow.intensity).toBe(0.8);
    frame();
    expect(shadowViewports().at(-1)).toEqual([0, 1536, 512, 512]);
  });

  it('leaves a map that is drawing alone when the tier keeps shadows on', async () => {
    const { light, tiers, frame } = await litTank();
    tiers.apply(1024);
    frame();
    light.shadow.needsUpdate = false;

    tiers.apply(2048);
    expect(light.shadow.needsUpdate).toBe(false);
    expect(light.shadow.autoUpdate).toBe(true);
    expect(light.shadow.intensity).toBe(0.8);
  });
});
