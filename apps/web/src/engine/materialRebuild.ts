import { Material, type Object3D } from 'three/webgpu';

/**
 * three marks a pipeline that failed to build and skips every draw that needs it while any render
 * object still uses it, so a mesh hit by a transient failure (a submit that bound a freed texture,
 * which an async compile's open error scope reports as its own) stays unseen for the session. A
 * material's dispose event is what three releases its render objects on, in every pass (scene,
 * reflection and shadow); once all of them are gone the broken pipeline goes too, and the next draw
 * builds afresh. Only the event is sent: the materials keep their own textures and node graphs, so
 * a fish keeps its swim deformation and instance data. A rebuild that keeps failing gives up after
 * `maxAttempts`.
 */
export class MaterialRebuild {
  private pending = false;
  private attempts = 0;

  constructor(private readonly maxAttempts = 3) {}

  /** Queues a rebuild for the next frame boundary; false once the attempts are used up. */
  request(): boolean {
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
