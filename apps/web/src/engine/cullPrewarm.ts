import type { Object3D } from 'three/webgpu';

/**
 * three builds a mesh's pipelines the first time it is drawn, and `compileAsync` culls to the view
 * frustum, so whatever starts off-screen (the tank's sides in a portrait viewport) compiles the
 * moment the camera first turns towards it. Each newly visible object is drawn once without frustum
 * culling instead, so it compiles while the tank loads.
 */
export class CullPrewarm {
  private readonly seen = new WeakSet<Object3D>();
  private readonly unculled: Object3D[] = [];
  private nextScanMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly root: Object3D,
    private readonly scanIntervalMs = 500,
  ) {
    if (!(scanIntervalMs >= 0)) {
      throw new RangeError(`CullPrewarm: scanIntervalMs must be >= 0, got ${scanIntervalMs}`);
    }
  }

  /** Call right before rendering; returns how many objects this frame draws unculled. */
  begin(nowMs: number): number {
    if (this.unculled.length > 0) throw new Error('CullPrewarm: begin() twice without end()');
    if (nowMs < this.nextScanMs) return 0;
    this.nextScanMs = nowMs + this.scanIntervalMs;
    this.root.traverseVisible((object) => {
      if (this.seen.has(object)) return;
      this.seen.add(object);
      if (object.frustumCulled) {
        object.frustumCulled = false;
        this.unculled.push(object);
      }
    });
    return this.unculled.length;
  }

  /** Call right after rendering, also when the render threw. */
  end(): void {
    for (const object of this.unculled) object.frustumCulled = true;
    this.unculled.length = 0;
  }
}
