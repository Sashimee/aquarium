import type { LightShadow } from 'three/webgpu';

export interface TierShadowLight {
  castShadow: boolean;
  readonly shadow: Pick<
    LightShadow,
    'mapSize' | 'map' | 'autoUpdate' | 'needsUpdate' | 'intensity'
  >;
}

/**
 * Applies a tier's shadow map size to a light without ever freeing its shadow map once three has
 * allocated it (`ShadowNode.setupShadow` sets `shadow.map` when the first lit pipeline builds).
 * Both ways a tier change could free it destroy its depth texture on the GPU at once: a new size
 * through `RenderTarget.setSize`, and shadows off through `ShadowNode.dispose` when the lights
 * rebuild. three only drops the cached bind groups it tracked on that texture, so a bind group it
 * missed outlives it: every submit that binds it fails and loses the whole frame, and an async
 * compile whose error scope is open meanwhile marks its own pipeline broken (#1300). So the size
 * first allocated stays for the session, and a tier without shadows stops drawing the map and fades
 * it out instead.
 */
export class TierShadow {
  private readonly intensity: number;

  constructor(private readonly light: TierShadowLight) {
    this.intensity = light.shadow.intensity;
  }

  /** `size` 0 turns the shadow off. */
  apply(size: number): void {
    const { light } = this;
    const shadow = light.shadow;
    const on = size > 0;
    if (shadow.map === null) {
      light.castShadow = on;
      if (on) shadow.mapSize.set(size, size);
      return;
    }
    shadow.intensity = on ? this.intensity : 0;
    if (on && !shadow.autoUpdate) shadow.needsUpdate = true;
    shadow.autoUpdate = on;
  }
}
