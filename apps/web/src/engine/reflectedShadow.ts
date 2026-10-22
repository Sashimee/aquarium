export interface ReflectedShadowMap {
  autoUpdate: boolean;
  readonly mapSize: { readonly x: number };
}

/**
 * The hood's shadow map does not depend on the view, but three redraws it once per camera and
 * frame: the mirrored camera uses the last one drawn for the scene camera. It draws the map itself
 * only on its first frame and when the light starts casting, so that the map exists before the
 * reflection's objects bind it; TierShadow never reallocates it after that. A size counts as seen
 * only once the reflection actually drew with it, since a skipped pass bound nothing.
 */
export class ReflectedShadow {
  private drawnSize = 0;

  /** `render` draws the reflection and returns whether it drew anything. */
  draw(shadow: ReflectedShadowMap, castShadow: boolean, render: () => boolean): boolean {
    const autoUpdate = shadow.autoUpdate;
    const size = castShadow ? shadow.mapSize.x : 0;
    shadow.autoUpdate = autoUpdate && size !== this.drawnSize;
    try {
      const drew = render();
      if (drew) this.drawnSize = size;
      return drew;
    } finally {
      shadow.autoUpdate = autoUpdate;
    }
  }
}
