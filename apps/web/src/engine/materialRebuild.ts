import { Material, type Object3D } from 'three/webgpu';

/**
 * three marks a pipeline that failed to build and skips every draw that needs it while any render
 * object still uses it, so a mesh hit by a transient failure (a submit that bound a freed texture,
 * which an async compile's open error scope reports as its own) stays unseen for the session. A
 * material's dispose event is what three releases its render objects on, in every pass (scene,
 * reflection and shadow); once all of them are gone the broken pipeline goes too, and the next draw
 * builds afresh. Only the event is sent: the materials keep their own textures and node graphs, so
 * a fish keeps its swim deformation and instance data.
 *
 * The rebuilds a burst of failures may ask for are capped at `maxAttempts`, so a failure the
 * rebuild brings back each time gives up. A burst ends once `quietMs` of wall-clock time pass
 * between two failures, frames or not, and the next one, which has another cause, gets the whole
 * budget again.
 */
export class MaterialRebuild {
  private pending = false;
  private attempts = 0;
  private lastFailureMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly maxAttempts = 3,
    private readonly quietMs = 10_000,
  ) {}

  /**
   * Queues a rebuild for the next frame boundary for a failure seen at `nowMs`; false once this
   * burst's attempts are used up.
   */
  request(nowMs: number): boolean {
    if (nowMs - this.lastFailureMs >= this.quietMs) this.attempts = 0;
    this.lastFailureMs = nowMs;
    if (this.pending) return true;
    if (this.attempts >= this.maxAttempts) return false;
    this.pending = true;
    this.attempts++;
    return true;
  }

  /** Call between frames: releases three's render objects for every material under `root`. */
  flush(root: Object3D): number {
    if (!this.pending) return 0;
    this.pending = false;
    const materials = new Set<Material>();
    root.traverse((object) => {
      if (!('material' in object)) return;
      const material: unknown = object.material;
      const list: unknown[] = Array.isArray(material) ? material : [material];
      for (const m of list) {
        if (m instanceof Material) materials.add(m);
      }
    });
    for (const material of materials) material.dispatchEvent({ type: 'dispose' });
    return materials.size;
  }
}
