import {
  Backend,
  Renderer,
  StandardNodeLibrary,
  Vector4,
  WGSLNodeBuilder,
  WebGPUCoordinateSystem,
  type Camera,
  type CoordinateSystem,
  type Object3D,
  type RenderTarget,
} from 'three/webgpu';

/** A render pass as three hands it to its backend. */
export interface InertPass {
  readonly renderTarget: RenderTarget | null;
  /** Null when three leaves the viewport at the whole attachment. */
  readonly viewport: Vector4 | null;
}

interface RenderContextView {
  renderTarget: RenderTarget | null;
  viewport: boolean;
  viewportValue: Vector4;
}

class InertBackend extends Backend {
  readonly passes: InertPass[] = [];
  readonly device = { features: new Set<string>() };
  readonly capabilities = { getUniformBufferLimit: () => 65536, getMaxAnisotropy: () => 1 };
  readonly extensions = { has: () => false, get: () => null };
  readonly utils = {
    getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }),
  };

  get coordinateSystem(): CoordinateSystem {
    return WebGPUCoordinateSystem;
  }

  createNodeBuilder(object: Object3D, renderer: Renderer): WGSLNodeBuilder {
    return new WGSLNodeBuilder(object, renderer);
  }

  beginRender(context: RenderContextView): void {
    this.passes.push({
      renderTarget: context.renderTarget,
      viewport: context.viewport ? context.viewportValue.clone() : null,
    });
  }
}

const CANVAS = {
  style: {},
  width: 300,
  height: 150,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as HTMLCanvasElement;

export interface InertRenderObject {
  readonly object: Object3D;
  readonly camera: Camera;
}

export interface InertRenderer {
  readonly renderer: Renderer;
  /** Every pass begun so far, shadow passes included. */
  readonly passes: InertPass[];
  /** The render objects three holds now, in every pass. */
  renderObjects(): ReadonlySet<InertRenderObject>;
  /** Runs three's frame tick, which the browser would between two frames. */
  nextFrame(): void;
}

/**
 * Test fixture: three's own `Renderer`, node building, render objects and shadow passes on a
 * backend that draws nothing, so what three does with them can be held to without a GPU.
 */
export async function createInertRenderer(): Promise<InertRenderer> {
  const backend = new InertBackend({ canvas: CANVAS });
  const renderer = new Renderer(backend);
  renderer.library = new StandardNodeLibrary();
  renderer.shadowMap.enabled = true;
  let tick: ((time: number) => void) | null = null;
  const frames = {
    requestAnimationFrame: (callback: (time: number) => void) => {
      tick = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      tick = null;
    },
  };
  // three's frame loop is built during init and keeps the `self` it found; node has none.
  const hadSelf = Reflect.has(globalThis, 'self');
  const self: unknown = Reflect.get(globalThis, 'self');
  Reflect.set(globalThis, 'self', frames);
  try {
    await renderer.init();
  } finally {
    if (hadSelf) Reflect.set(globalThis, 'self', self);
    else Reflect.deleteProperty(globalThis, 'self');
  }
  const internals = renderer as unknown as {
    _objects: { _renderObjects: Set<InertRenderObject> };
  };
  return {
    renderer,
    passes: backend.passes,
    renderObjects: () => internals._objects._renderObjects,
    nextFrame: () => {
      if (tick === null) throw new Error('createInertRenderer: three stopped its frame loop');
      tick(performance.now());
    },
  };
}
