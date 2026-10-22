import { DepthTexture, DirectionalLight, RenderTarget, type LightShadow } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { resizeShadowMap } from './shadowMapSize';

/** The hood's shadow as three leaves it once drawn: a render target with a depth texture. */
function drawnShadow(size: number) {
  const shadow = new DirectionalLight().shadow;
  shadow.mapSize.set(size, size);
  const map = new RenderTarget(size, size);
  const depthTexture = new DepthTexture(size, size);
  depthTexture.name = 'ShadowDepthTexture';
  map.depthTexture = depthTexture;
  shadow.map = map;
  const freed: string[] = [];
  map.addEventListener('dispose', () => freed.push('ShadowDepthTexture'));
  return { shadow, map, freed };
}

/** What three's ShadowNode.renderShadow does first, inside the render pass that needs the map. */
function drawInRenderPass(shadow: LightShadow) {
  shadow.map?.setSize(shadow.mapSize.width, shadow.mapSize.height, shadow.map.depth);
}

describe('resizeShadowMap', () => {
  it('frees the old shadow textures at the tier change, never inside the next render pass', () => {
    const { shadow, map, freed } = drawnShadow(1024);
    resizeShadowMap(shadow, 2048);
    expect(freed).toEqual(['ShadowDepthTexture']);
    expect([map.width, map.height]).toEqual([2048, 2048]);

    freed.length = 0;
    drawInRenderPass(shadow);
    expect(freed).toEqual([]);
  });

  it('frees nothing when the size is unchanged', () => {
    const { shadow, freed } = drawnShadow(2048);
    resizeShadowMap(shadow, 2048);
    drawInRenderPass(shadow);
    expect(freed).toEqual([]);
  });

  it('only records the size while three has not drawn the map yet', () => {
    const shadow = new DirectionalLight().shadow;
    resizeShadowMap(shadow, 1024);
    expect(shadow.map).toBeNull();
    expect(shadow.mapSize.toArray()).toEqual([1024, 1024]);
  });
});
