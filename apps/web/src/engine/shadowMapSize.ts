import type { LightShadow } from 'three/webgpu';

/**
 * Sets the shadow map's size and reallocates it now. Left to three, the map is reallocated when
 * it is next drawn, which is inside a render pass: draws already encoded in that frame bind the
 * old depth texture, so freeing it fails their submit ("Destroyed texture used in a submit"), and
 * an async pipeline compile whose error scope is still open reports that error as its own. Between
 * frames nothing encoded binds the old texture, and three drops the cached bind groups that did;
 * command buffers already submitted with it keep it alive on the GPU until they finish.
 */
export function resizeShadowMap(shadow: Pick<LightShadow, 'mapSize' | 'map'>, size: number): void {
  shadow.mapSize.set(size, size);
  shadow.map?.setSize(size, size, shadow.map.depth);
}
