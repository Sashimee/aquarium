/** three's render-pipeline cache (`renderer._pipelines`) as far as starting a pipeline goes. */
interface PipelineCache {
  getForRender(renderObject: object, promises?: Promise<void>[] | null): unknown;
  updateForRender(renderObject: object): void;
}

function isPipelineCache(value: unknown): value is PipelineCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'getForRender') === 'function' &&
    typeof Reflect.get(value, 'updateForRender') === 'function'
  );
}

export interface ParallelCompile {
  /** Runs `draw` with the render path starting new pipelines without waiting for their link. */
  during<T>(draw: () => T): T;
  /** Pipelines started in parallel whose link has not finished yet. */
  readonly pending: number;
  /** How many pipelines were started in parallel so far. */
  readonly started: number;
  restore(): void;
}

/**
 * three's render path builds a new pipeline synchronously, and on WebGL that waits for the
 * driver to link the program, and for the GPU to finish every frame queued before it, when a new
 * tank's objects first draw. `compileAsync` alone does not help, as it skips culled and hidden
 * objects, shadow passes and post passes' render targets. Inside `during`, a new pipeline for an
 * object `accept` admits is started the way `compileAsync` starts one instead: with
 * KHR_parallel_shader_compile the backend polls the link once a frame and three skips the
 * object's draws until it is ready, so it appears a few frames late rather than freezing the page.
 * Without the extension (SwiftShader) three links synchronously as before.
 *
 * Only for the WebGL backend: WebGPU's async pipeline path pops an error scope after an await,
 * which other pipelines created in between would interleave with.
 */
export function compileInParallel(
  renderer: object,
  accept: (renderObject: object) => boolean,
): ParallelCompile {
  const pipelines: unknown = Reflect.get(renderer, '_pipelines');
  if (!isPipelineCache(pipelines)) {
    throw new Error(
      'compileInParallel: renderer._pipelines has no getForRender/updateForRender; three changed its pipeline cache',
    );
  }
  const hadOwn = Object.hasOwn(pipelines, 'updateForRender');
  const original = pipelines.updateForRender;
  let active = false;
  let pending = 0;
  let started = 0;
  const promises: Promise<void>[] = [];

  const updateForRender = function (this: PipelineCache, renderObject: object): void {
    if (!active || !accept(renderObject)) {
      original.call(this, renderObject);
      return;
    }
    this.getForRender(renderObject, promises);
    for (const promise of promises) {
      pending++;
      started++;
      const settle = (): void => {
        pending--;
      };
      promise.then(settle, settle);
    }
    promises.length = 0;
  };
  Reflect.set(pipelines, 'updateForRender', updateForRender);

  return {
    during<T>(draw: () => T): T {
      if (active) return draw();
      active = true;
      try {
        return draw();
      } finally {
        active = false;
      }
    },
    get pending() {
      return pending;
    },
    get started() {
      return started;
    },
    restore() {
      if (Reflect.get(pipelines, 'updateForRender') !== updateForRender) return;
      if (hadOwn) Reflect.set(pipelines, 'updateForRender', original);
      else Reflect.deleteProperty(pipelines, 'updateForRender');
    },
  };
}
