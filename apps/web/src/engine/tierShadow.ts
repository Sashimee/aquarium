import { Matrix4, ShadowNode, Vector4, type DirectionalLight, type NodeFrame } from 'three/webgpu';

/**
 * Where a shadow drawn at `size` texels sits in a square map of `capacity` texels: the viewport in
 * three's top-left render target space, and the scale that moves the shadow matrix's [0, 1]
 * coordinates onto it. The sampled y is `1 - y` (ShadowNode.setupShadowCoord), so a region at the
 * origin of the matrix's coordinates is the bottom-left corner of the viewport space; both
 * backends agree, as the WebGL one flips the viewport and its texture reads alike.
 */
export function shadowRegion(
  size: number,
  capacity: number,
): { viewport: Vector4; scale: Matrix4 } {
  if (!(size > 0 && size <= capacity)) {
    throw new RangeError(`shadowRegion: size ${size} is not within the ${capacity} map`);
  }
  const k = size / capacity;
  return {
    viewport: new Vector4(0, capacity - size, size, size),
    scale: new Matrix4().makeScale(k, k, 1),
  };
}

/**
 * The hood's shadow node: draws into a corner of the map, `drawnSize` texels on a side, and points
 * the shadow matrix at that corner in the same step, so the pass that draws the map and every pass
 * that samples it until the next draw agree. The sampling filter's texel size reads `mapSize`,
 * which stays the whole map's, and the whole map is cleared each draw, so what lies outside the
 * corner reads as lit like anything outside the light's frustum.
 */
export class TierShadowNode extends ShadowNode {
  drawnSize: number;

  constructor(light: DirectionalLight) {
    super(light, light.shadow);
    this.drawnSize = light.shadow.mapSize.width;
  }

  override renderShadow(frame: NodeFrame): void {
    const { shadow, shadowMap, light } = this;
    const { renderer, scene } = frame;
    if (renderer === null || scene === null) {
      throw new Error('TierShadowNode: the shadow was drawn outside a frame');
    }
    shadow.updateMatrices(light);
    shadowMap.setSize(shadow.mapSize.width, shadow.mapSize.height, shadowMap.depth);
    // setSize just reset the viewport to the whole map.
    const region = shadowRegion(this.drawnSize, shadowMap.width);
    shadowMap.viewport.copy(region.viewport);
    shadow.matrix.premultiply(region.scale);
    const sceneName = scene.name;
    scene.name = `Shadow Map [ ${light.name || `ID: ${light.id}`} ]`;
    try {
      renderer.render(scene, shadow.camera);
    } finally {
      scene.name = sceneName;
    }
  }
}

/**
 * Applies a tier's shadow resolution to a light without ever freeing its shadow map once three has
 * allocated it (`ShadowNode.setupShadow` sets `shadow.map` when the first lit pipeline builds).
 * Both ways a tier change could free it destroy its depth texture on the GPU at once: a new size
 * through `RenderTarget.setSize`, and shadows off through `ShadowNode.dispose` when the lights
 * rebuild. three only drops the cached bind groups it tracked on that texture, so a bind group it
 * missed outlives it: every submit that binds it fails and loses the whole frame, and an async
 * compile whose error scope is open meanwhile marks its own pipeline broken (#1300).
 *
 * So the map is allocated once at `capacity`, the largest tier's size, and each tier draws only a
 * corner of it at its own resolution: a lower tier rasterises and samples a quarter of the texels
 * or fewer, at the price of keeping the largest map's memory. A tier without shadows stops drawing
 * the map and fades it out.
 */
export class TierShadow {
  private readonly intensity: number;
  private readonly node: TierShadowNode;

  constructor(
    private readonly light: DirectionalLight,
    private readonly capacity: number,
  ) {
    if (!(capacity > 0)) throw new RangeError(`TierShadow: capacity ${capacity} must be > 0`);
    this.intensity = light.shadow.intensity;
    light.shadow.mapSize.set(capacity, capacity);
    this.node = new TierShadowNode(light);
    light.shadow.shadowNode = this.node;
  }

  /** `size` 0 turns the shadow off. */
  apply(size: number): void {
    if (size > this.capacity) {
      throw new RangeError(`TierShadow: size ${size} exceeds the ${this.capacity} map`);
    }
    const { light } = this;
    const shadow = light.shadow;
    const on = size > 0;
    if (on) this.node.drawnSize = size;
    if (shadow.map === null) {
      light.castShadow = on;
      return;
    }
    shadow.intensity = on ? this.intensity : 0;
    if (on && !shadow.autoUpdate) shadow.needsUpdate = true;
    shadow.autoUpdate = on;
  }
}
