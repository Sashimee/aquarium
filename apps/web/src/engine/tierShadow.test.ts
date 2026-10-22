import { DepthTexture, DirectionalLight, RenderTarget } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { TierShadow } from './tierShadow';

/** What three's ShadowNode does once a lit pipeline builds: a render target with a depth texture. */
function allocate(light: DirectionalLight) {
  const { width, height } = light.shadow.mapSize;
  const map = new RenderTarget(width, height);
  const depthTexture = new DepthTexture(width, height);
  depthTexture.name = 'ShadowDepthTexture';
  map.depthTexture = depthTexture;
  light.shadow.map = map;
  const freed: string[] = [];
  map.addEventListener('dispose', () => freed.push('ShadowDepthTexture'));
  return { map, freed };
}

/** What three's ShadowNode.renderShadow does first, inside the render pass that needs the map. */
function drawInRenderPass(light: DirectionalLight) {
  const { shadow } = light;
  shadow.map?.setSize(shadow.mapSize.width, shadow.mapSize.height, shadow.map.depth);
}

describe('TierShadow', () => {
  it('only records the size and the cast flag while three has not allocated the map', () => {
    const light = new DirectionalLight();
    const tiers = new TierShadow(light);
    tiers.apply(0);
    expect(light.castShadow).toBe(false);
    tiers.apply(1024);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.mapSize.toArray()).toEqual([1024, 1024]);
    tiers.apply(2048);
    expect(light.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    expect(light.shadow.map).toBeNull();
  });

  it('never frees the depth texture through low, medium, high and back once allocated', () => {
    const light = new DirectionalLight();
    const tiers = new TierShadow(light);
    tiers.apply(1024);
    const { map, freed } = allocate(light);

    for (const size of [2048, 0, 1024, 2048, 0, 2048]) {
      tiers.apply(size);
      drawInRenderPass(light);
      expect(light.castShadow).toBe(true);
    }
    expect(freed).toEqual([]);
    expect(light.shadow.map).toBe(map);
    expect([map.width, map.height]).toEqual([1024, 1024]);
    expect(light.shadow.mapSize.toArray()).toEqual([1024, 1024]);
  });

  it('stops drawing and fades out the allocated map on a tier without shadows', () => {
    const light = new DirectionalLight();
    light.shadow.intensity = 0.8;
    const tiers = new TierShadow(light);
    tiers.apply(2048);
    allocate(light);

    tiers.apply(0);
    expect(light.shadow.autoUpdate).toBe(false);
    expect(light.shadow.intensity).toBe(0);
  });

  it('draws the map again, at once, when shadows come back', () => {
    const light = new DirectionalLight();
    light.shadow.intensity = 0.8;
    const tiers = new TierShadow(light);
    tiers.apply(2048);
    allocate(light);
    tiers.apply(0);
    light.shadow.needsUpdate = false;

    tiers.apply(1024);
    expect(light.shadow.autoUpdate).toBe(true);
    expect(light.shadow.needsUpdate).toBe(true);
    expect(light.shadow.intensity).toBe(0.8);
  });

  it('leaves a map that is drawing alone when the tier keeps shadows on', () => {
    const light = new DirectionalLight();
    const tiers = new TierShadow(light);
    tiers.apply(1024);
    allocate(light);
    light.shadow.needsUpdate = false;

    tiers.apply(2048);
    expect(light.shadow.needsUpdate).toBe(false);
    expect(light.shadow.autoUpdate).toBe(true);
    expect(light.shadow.intensity).toBe(1);
  });
});
