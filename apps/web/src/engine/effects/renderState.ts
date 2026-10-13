import type {
  Camera,
  ContextNode,
  Lighting,
  MRTNode,
  RenderTarget,
  Scene,
  ToneMapping,
} from 'three/webgpu';

/** The renderer settings a post pipeline or pass changes while it draws. */
export interface RenderStateTarget {
  getRenderTarget(): RenderTarget | null;
  setRenderTarget(target: RenderTarget | null): void;
  getMRT(): MRTNode | null;
  setMRT(mrt: MRTNode | null): unknown;
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  transparent: boolean;
  opaque: boolean;
  lighting: Lighting;
  contextNode: ContextNode<unknown>;
  toneMapping: ToneMapping;
  outputColorSpace: string;
  readonly xr: { enabled: boolean };
}

/**
 * `RenderPipeline.render()` and `PassNode.updateBefore()` only put these back when they return
 * normally, so a node-build error part-way leaves the next plain render drawing off-screen into
 * a disposed target, untone-mapped. Returns a function that restores what was captured.
 */
export function captureRenderState(
  renderer: RenderStateTarget,
  scene: Pick<Scene, 'name' | 'overrideMaterial'>,
  camera: Pick<Camera, 'layers'>,
): () => void {
  const target = renderer.getRenderTarget();
  const mrt = renderer.getMRT();
  const {
    autoClear,
    autoClearColor,
    autoClearDepth,
    autoClearStencil,
    transparent,
    opaque,
    lighting,
    contextNode,
    toneMapping,
    outputColorSpace,
  } = renderer;
  const xr = renderer.xr.enabled;
  const { name, overrideMaterial } = scene;
  const mask = camera.layers.mask;
  return () => {
    renderer.setRenderTarget(target);
    renderer.setMRT(mrt);
    renderer.autoClear = autoClear;
    renderer.autoClearColor = autoClearColor;
    renderer.autoClearDepth = autoClearDepth;
    renderer.autoClearStencil = autoClearStencil;
    renderer.transparent = transparent;
    renderer.opaque = opaque;
    renderer.lighting = lighting;
    renderer.contextNode = contextNode;
    renderer.toneMapping = toneMapping;
    renderer.outputColorSpace = outputColorSpace;
    renderer.xr.enabled = xr;
    scene.name = name;
    scene.overrideMaterial = overrideMaterial;
    camera.layers.mask = mask;
  };
}
