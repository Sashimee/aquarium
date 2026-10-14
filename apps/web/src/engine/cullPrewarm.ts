import type { Material, Object3D } from 'three/webgpu';

/** Changes when the object's materials are swapped or flagged `needsUpdate`. */
function materialKey(object: Object3D): string {
  const { material } = object as Object3D & { material?: Material | Material[] };
  if (material === undefined) return '';
  const list = Array.isArray(material) ? material : [material];
  return list.map((m) => `${m.uuid}:${m.version}`).join(',');
}

/**
 * three builds a mesh's pipelines the first time it is drawn, and `compileAsync` culls to the view
 * frustum, so whatever starts off-screen (the tank's sides in a portrait viewport) compiles the
 * moment the camera first turns towards it. Each newly visible object is drawn once without frustum
 * culling instead, so it compiles while the tank loads. The same goes again for an object whose
 * material changed, for everything once a light joins (every lit pipeline depends on the lights),
 * and for everything after `invalidate()`.
 */
export class CullPrewarm {
  private seen = new WeakMap<Object3D, string>();
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

  /** Warms every visible object again on the next `begin`, for changes no material shows. */
  invalidate(): void {
    this.seen = new WeakMap();
    this.nextScanMs = Number.NEGATIVE_INFINITY;
  }

  /** Call right before rendering; returns how many objects this frame draws unculled. */
  begin(nowMs: number): number {
    if (this.unculled.length > 0) throw new Error('CullPrewarm: begin() twice without end()');
    if (nowMs < this.nextScanMs) return 0;
    this.nextScanMs = nowMs + this.scanIntervalMs;
    const visible: Object3D[] = [];
    const changed: Object3D[] = [];
    let lightJoined = false;
    this.root.traverseVisible((object) => {
      visible.push(object);
      const key = materialKey(object);
      const before = this.seen.get(object);
      if (before === key) return;
      if (before === undefined && (object as Object3D & { isLight?: boolean }).isLight === true) {
        lightJoined = true;
      }
      this.seen.set(object, key);
      changed.push(object);
    });
    for (const object of lightJoined ? visible : changed) {
      if (!object.frustumCulled) continue;
      object.frustumCulled = false;
      this.unculled.push(object);
    }
    return this.unculled.length;
  }

  /** Call right after rendering, also when the render threw. */
  end(): void {
    for (const object of this.unculled) object.frustumCulled = true;
    this.unculled.length = 0;
  }
}
