import {
  Color,
  ConstNode,
  ConvertNode,
  MathNode,
  OperatorNode,
  PerspectiveCamera,
  Scene,
  SplitNode,
  UniformNode,
  VarNode,
  Vector3,
  WebGPURenderer,
  type Light,
  type Mesh,
  type Node,
} from 'three/webgpu';

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
  const shaders = { vertex: builder.vertexShader, fragment: builder.fragmentShader };
  if (backend === 'webgpu') {
    assertSamplersDeclared(shaders.vertex, 'vertex');
    assertSamplersDeclared(shaders.fragment, 'fragment');
  }
  return shaders;
}

/**
 * three declares no sampler for a texture it deems unfilterable (both filters nearest, for one),
 * yet a biased sample and a few others still name one, so the WGSL fails to compile and the
 * device is lost. three 0.186.1, `WGSLNodeBuilder.generateTextureBias`.
 */
export function assertSamplersDeclared(source: string, stage: string): void {
  const declared = new Set(
    [...source.matchAll(/\bvar\s+(\w+_sampler)\s*:\s*sampler(?:_comparison)?\b/g)].map((m) => m[1]),
  );
  const missing = new Set(
    [...source.matchAll(/\b(\w+_sampler)\b/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined && !declared.has(name)),
  );
  if (missing.size > 0) {
    throw new Error(
      `${stage} shader samples through undeclared ${[...missing].join(', ')}: the texture is ` +
        'unfilterable (both filters nearest?) yet sampled with a bias or similar. Give it a ' +
        'linear filter or sample it with .level().',
    );
  }
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

/**
 * Evaluates the arithmetic subset of a TSL graph on the CPU, so a JS mirror of shader maths can be
 * held to the graph itself instead of to a third copy of the formula.
 */
export function evaluate(node: Node): number[] {
  if (node instanceof UniformNode || node instanceof ConstNode) {
    const value: unknown = node.value;
    if (typeof value === 'number') return [value];
    if (value instanceof Vector3) return value.toArray();
    if (value instanceof Color) return value.toArray();
    throw new Error(`evaluate: unsupported ${node.type} value`);
  }
  if (node instanceof VarNode || node instanceof ConvertNode) return evaluate(node.node);
  if (node instanceof SplitNode) {
    const v = evaluate(node.node);
    return [...node.components].map((c) => v['xyzw'.indexOf(c)] ?? Number.NaN);
  }
  const zip = (a: number[], b: number[], f: (x: number, y: number) => number): number[] =>
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      f(a.length === 1 ? (a[0] ?? 0) : (a[i] ?? 0), b.length === 1 ? (b[0] ?? 0) : (b[i] ?? 0)),
    );
  if (node instanceof OperatorNode) {
    const a = evaluate(node.aNode);
    const b = evaluate(node.bNode);
    if (node.op === '+') return zip(a, b, (x, y) => x + y);
    if (node.op === '-') return zip(a, b, (x, y) => x - y);
    if (node.op === '*') return zip(a, b, (x, y) => x * y);
    if (node.op === '/') return zip(a, b, (x, y) => x / y);
    throw new Error(`evaluate: unsupported operator ${node.op}`);
  }
  if (node instanceof MathNode) {
    const a = evaluate(node.aNode);
    if (node.method === MathNode.EXP) return a.map(Math.exp);
    if (node.method === MathNode.NEGATE) return a.map((x) => -x);
    if (node.method === MathNode.ABS) return a.map(Math.abs);
    if (node.method === MathNode.ONE_MINUS) return a.map((x) => 1 - x);
    if (node.bNode === null) throw new Error(`evaluate: unsupported math ${node.method}`);
    const b = evaluate(node.bNode);
    if (node.method === MathNode.MAX) return zip(a, b, Math.max);
    if (node.method === MathNode.MIN) return zip(a, b, Math.min);
    if (node.method === MathNode.POW) return zip(a, b, Math.pow);
    throw new Error(`evaluate: unsupported math ${node.method}`);
  }
  throw new Error(`evaluate: unsupported node ${node.type}`);
}
