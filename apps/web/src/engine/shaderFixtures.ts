import { PerspectiveCamera, Scene, WebGPURenderer, type Light, type Mesh } from 'three/webgpu';

export type ShaderBackend = 'webgpu' | 'webgl';

export interface BuiltShaders {
  readonly vertex: string;
  readonly fragment: string;
}

interface Builder {
  scene: Scene;
  material: unknown;
  camera: PerspectiveCamera;
  context: { material: unknown };
  lightsNode: { setLights(lights: Light[]): void } | null;
  build(): void;
  vertexShader: string;
  fragmentShader: string;
}

const CANVAS = {
  style: {},
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as HTMLCanvasElement;

/**
 * Test fixture: the WGSL or GLSL three generates for `mesh`, built the way the renderer builds a
 * render object but without a GPU. The device queries the builders make answer as a baseline
 * device with no optional features, so whatever the shader needs from one is declared in it.
 */
export function buildShaders(
  mesh: Mesh,
  backend: ShaderBackend,
  lights: readonly Light[] = [],
): BuiltShaders {
  const scene = new Scene();
  scene.add(mesh, ...lights);
  const camera = new PerspectiveCamera();
  const renderer = new WebGPURenderer({ canvas: CANVAS, forceWebGL: backend === 'webgl' });
  const internals = renderer as unknown as {
    _initialized: boolean;
    lighting: { getNode(scene: Scene, camera: PerspectiveCamera): Builder['lightsNode'] };
    backend: Record<string, unknown> & {
      createNodeBuilder(object: Mesh, renderer: WebGPURenderer): Builder;
    };
  };
  internals._initialized = true;
  internals.backend.device = { features: new Set<string>() };
  internals.backend.capabilities = {
    getUniformBufferLimit: () => 65536,
    getMaxAnisotropy: () => 1,
  };
  internals.backend.extensions = { has: () => false, get: () => null };
  const builder = internals.backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = mesh.material;
  builder.camera = camera;
  builder.context.material = mesh.material;
  if (lights.length > 0) {
    builder.lightsNode = internals.lighting.getNode(scene, camera);
    builder.lightsNode?.setLights([...lights]);
  }
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}

/**
 * The lines of `main` in a generated shader with the depth of block nesting each sits at, 0 being
 * `main`'s own body.
 */
export function mainBodyDepths(source: string): { line: string; depth: number }[] {
  const start = source.search(/\b(fn\s+main\s*\(|void\s+main\s*\()/);
  if (start < 0) throw new Error('mainBodyDepths: the shader has no main function');
  const out: { line: string; depth: number }[] = [];
  let depth = -1;
  for (const line of source.slice(start).split('\n')) {
    const closes = (line.match(/}/g) ?? []).length;
    const opens = (line.match(/{/g) ?? []).length;
    const at = depth - (line.trimStart().startsWith('}') ? 1 : 0);
    if (depth >= 0) out.push({ line: line.trim(), depth: at });
    depth += opens - closes;
    if (depth < 0 && out.length > 0) break;
  }
  return out;
}
