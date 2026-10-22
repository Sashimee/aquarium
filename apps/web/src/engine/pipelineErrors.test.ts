import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  DirectionalLight,
  getConsoleFunction,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  setConsoleFunction,
  ShadowBaseNode,
  WebGLBackend,
} from 'three/webgpu';
import {
  blameEffects,
  linkFailureMessage,
  materialIdOf,
  parsePipelineFailure,
  PipelineFailureHandler,
  type DroppableEffects,
  materialUse,
  watchPipelineErrors,
  type FailureContext,
  type PipelineFailure,
  type ShaderLogs,
  type WatchedRenderer,
} from './pipelineErrors';
import { createInertRenderer } from './inertRenderer';
import { TierShadow } from './tierShadow';

/** A lit, shadow-casting box drawn once, and the material three drew its shadow pass with. */
async function shadowedScene() {
  const { renderer, renderObjects } = await createInertRenderer();
  const scene = new Scene();
  const light = new DirectionalLight();
  new TierShadow(light, 1024).apply(1024);
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(light, mesh);
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  renderer.render(scene, camera);
  const shadowPass = [...renderObjects()].find((r) => r.camera === light.shadow.camera);
  if (shadowPass === undefined) throw new Error('three drew no shadow pass');
  return { scene, light, mesh, shadowMaterialId: materialIdOf(shadowPass.material) ?? -1 };
}

describe('parsePipelineFailure', () => {
  it('reads the material id from a failed render pipeline', () => {
    const message =
      'THREE.WebGPURenderer: Render pipeline creation failed (renderPipeline_fish_body_42): ' +
      'Error while parsing WGSL';
    expect(parsePipelineFailure(message)).toEqual({ kind: 'render', materialId: 42, message });
  });

  it('reads it from an async build and a name with brackets and digits', () => {
    const message =
      'THREE.WebGPURenderer: Async render pipeline creation failed ' +
      '(renderPipeline_glass (front)_2_317): unknown';
    expect(parsePipelineFailure(message)?.materialId).toBe(317);
  });

  it('reports a compute failure without a material', () => {
    const message =
      'THREE.WebGPURenderer: Compute pipeline creation failed (computePipeline_9): bad binding';
    expect(parsePipelineFailure(message)).toEqual({ kind: 'compute', materialId: null, message });
    expect(
      parsePipelineFailure(
        'THREE.WebGPURenderer: Async compute pipeline creation failed (x): unknown',
      )?.kind,
    ).toBe('compute');
  });

  it('keeps a render failure whose label it cannot read, without a material', () => {
    const message = 'THREE.WebGPURenderer: Render pipeline creation failed (custom): broken';
    expect(parsePipelineFailure(message)).toEqual({ kind: 'render', materialId: null, message });
  });

  it('ignores every other message', () => {
    expect(parsePipelineFailure('THREE.WebGPURenderer: Device lost')).toBeNull();
    expect(parsePipelineFailure('TSL: Node "x" is not defined')).toBeNull();
    expect(parsePipelineFailure('')).toBeNull();
  });
});

describe('linkFailureMessage', () => {
  interface Stage {
    compiled: boolean;
    log: string | null;
    source: string | null;
  }

  function gl(program: string | null, vertex: Stage, fragment: Stage) {
    const vertexShader = {};
    const fragmentShader = {};
    const stage = (shader: WebGLShader) => (shader === vertexShader ? vertex : fragment);
    const logs: ShaderLogs = {
      COMPILE_STATUS: 0x8b81,
      getProgramInfoLog: () => program,
      getShaderInfoLog: (shader) => stage(shader).log,
      getShaderParameter: (shader, name) => name === 0x8b81 && stage(shader).compiled,
      getShaderSource: (shader) => stage(shader).source,
    };
    return { logs, vertexShader, fragmentShader };
  }

  const ok: Stage = { compiled: true, log: '', source: 'void main() {}' };
  const source = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');

  it('marks the failing source line with five lines before and six after, as three does', () => {
    const failing: Stage = { compiled: false, log: "ERROR: 0:10: 'foo' : undeclared", source };
    const { logs, vertexShader, fragmentShader } = gl('link failed\n', ok, failing);
    const message = linkFailureMessage(logs, {}, vertexShader, fragmentShader);
    expect(message).toBe(
      [
        'THREE.WebGLProgram: Shader Error - program failed to link',
        'Program Info Log: link failed',
        "FRAGMENT\n\nERROR: 0:10: 'foo' : undeclared",
        [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
          .map((n) => `${n === 10 ? '>' : ' '} ${n}: line${n}`)
          .join('\n'),
      ].join('\n\n'),
    );
  });

  it('clips the excerpt at the ends of the source', () => {
    const failing: Stage = { compiled: false, log: 'ERROR: 0:1: syntax error', source };
    const { logs, vertexShader, fragmentShader } = gl('', failing, ok);
    const message = linkFailureMessage(logs, {}, vertexShader, fragmentShader);
    expect(message).toContain('> 1: line1\n  2: line2');
    expect(message).toContain('  7: line7');
    expect(message).not.toContain(' 8: line8');
  });

  it('gives the bare log when it names no line', () => {
    const failing: Stage = { compiled: false, log: ' out of memory ', source };
    const { logs, vertexShader, fragmentShader } = gl(null, failing, ok);
    expect(linkFailureMessage(logs, {}, vertexShader, fragmentShader)).toBe(
      [
        'THREE.WebGLProgram: Shader Error - program failed to link',
        'Program Info Log: ',
        'out of memory',
      ].join('\n\n'),
    );
  });

  it('keeps warnings from a shader that compiled', () => {
    const warned: Stage = { compiled: true, log: 'WARNING: precision', source };
    const { logs, vertexShader, fragmentShader } = gl('', warned, ok);
    expect(linkFailureMessage(logs, {}, vertexShader, fragmentShader)).toContain(
      'WARNING: precision',
    );
  });
});

function fakeRenderer(backend: object = {}): WatchedRenderer<ShaderLogs> {
  return { backend, debug: { onShaderError: null } };
}

describe('watchPipelineErrors', () => {
  // three's declarations omit the null it returns before anything is set.
  const original: ReturnType<typeof getConsoleFunction> | null = getConsoleFunction();
  afterEach(() => {
    if (original !== null) setConsoleFunction(original);
  });

  function installRecorder() {
    const forwarded: unknown[][] = [];
    const recorder = (type: 'log' | 'warn' | 'error', message: string, ...params: unknown[]) => {
      forwarded.push([type, message, ...params]);
    };
    setConsoleFunction(recorder);
    return { forwarded, recorder };
  }

  const linkLogs: ShaderLogs = {
    COMPILE_STATUS: 0x8b81,
    getProgramInfoLog: () => 'link failed',
    getShaderInfoLog: () => '',
    getShaderParameter: () => true,
    getShaderSource: () => null,
  };

  it('hears a pipeline failure and still forwards every message', () => {
    const { forwarded } = installRecorder();
    const failures: PipelineFailure[] = [];
    const stop = watchPipelineErrors(fakeRenderer(), (f) => failures.push(f));
    const log = getConsoleFunction();
    const failed = 'THREE.WebGPURenderer: Render pipeline creation failed (renderPipeline_a_5): x';

    log('error', failed);
    log('warn', 'THREE.WebGPURenderer: Render pipeline creation failed (renderPipeline_a_6): x');
    log('log', 'THREE.something else', 1, 2);

    expect(failures).toEqual([{ kind: 'render', materialId: 5, message: failed }]);
    expect(forwarded.map(([type]) => type)).toEqual(['error', 'warn', 'log']);
    expect(forwarded[2]).toEqual(['log', 'THREE.something else', 1, 2]);
    stop();
  });

  it('puts the previous console function back', () => {
    const { recorder } = installRecorder();
    const stop = watchPipelineErrors(fakeRenderer(), () => undefined);
    expect(getConsoleFunction()).not.toBe(recorder);
    stop();
    expect(getConsoleFunction()).toBe(recorder);
  });

  it('leaves a console function installed after it alone', () => {
    installRecorder();
    const stop = watchPipelineErrors(fakeRenderer(), () => undefined);
    const later = () => undefined;
    setConsoleFunction(later);
    stop();
    expect(getConsoleFunction()).toBe(later);
  });

  it('hooks the WebGL shader error callback and restores the previous one', () => {
    const renderer = fakeRenderer();
    const previous = () => undefined;
    renderer.debug.onShaderError = previous;
    const stop = watchPipelineErrors(renderer, () => undefined);
    expect(renderer.debug.onShaderError).not.toBe(previous);
    expect(renderer.debug.onShaderError).toBeTypeOf('function');
    stop();
    expect(renderer.debug.onShaderError).toBe(previous);
  });

  it('names the material whose WebGL program failed to link, and unhooks the backend', () => {
    installRecorder();
    const material = new MeshBasicNodeMaterial();
    const renderer = fakeRenderer();
    const backend = {
      _completeCompile(renderObject: { material: unknown }): string {
        const onShaderError = renderer.debug.onShaderError;
        if (renderObject.material === material && onShaderError !== null) {
          onShaderError(linkLogs, {}, {}, {});
        }
        return 'completed';
      },
    };
    Object.assign(renderer, { backend });
    const original = backend._completeCompile;
    const failures: PipelineFailure[] = [];
    const stop = watchPipelineErrors(renderer, (f) => failures.push(f));

    expect(backend._completeCompile({ material })).toBe('completed');
    renderer.debug.onShaderError?.(linkLogs, {}, {}, {});

    expect(failures.map((f) => f.materialId)).toEqual([materialIdOf(material), null]);
    stop();
    expect(backend._completeCompile).toBe(original);
  });

  it('leaves the material unknown on a backend that does not link through _completeCompile', () => {
    installRecorder();
    const renderer = fakeRenderer();
    const failures: PipelineFailure[] = [];
    const stop = watchPipelineErrors(renderer, (f) => failures.push(f));
    renderer.debug.onShaderError?.(linkLogs, {}, {}, {});
    expect(failures.map((f) => f.materialId)).toEqual([null]);
    stop();
    expect(renderer.backend).toEqual({});
  });

  it('finds _completeCompile on the installed WebGL backend', () => {
    expect(Reflect.get(WebGLBackend.prototype, '_completeCompile')).toBeTypeOf('function');
  });
});

describe('materialUse', () => {
  it('finds a material on a hidden, nested object and in a material array', () => {
    const scene = new Scene();
    const hiddenMaterial = new MeshBasicNodeMaterial();
    const arrayMaterial = new MeshStandardNodeMaterial();
    const group = new Group();
    const hidden = new Mesh(undefined, hiddenMaterial);
    hidden.visible = false;
    group.add(hidden);
    scene.add(group, new Mesh(undefined, [new MeshBasicNodeMaterial(), arrayMaterial]));

    expect(materialUse(scene, materialIdOf(hiddenMaterial) ?? -1)).toBe('object');
    expect(materialUse(scene, materialIdOf(arrayMaterial) ?? -1)).toBe('object');
    expect(materialUse(scene, materialIdOf(new MeshBasicNodeMaterial()) ?? -1)).toBeNull();
  });

  it('finds nothing in an empty scene', () => {
    expect(materialUse(new Scene(), 0)).toBeNull();
  });

  it("finds the material three draws a casting light's shadow pass with", async () => {
    const { scene, light, mesh, shadowMaterialId } = await shadowedScene();
    expect(shadowMaterialId).not.toBe(materialIdOf(mesh.material));
    expect(materialUse(scene, shadowMaterialId)).toBe('shadow');

    light.castShadow = false;
    expect(materialUse(scene, shadowMaterialId)).toBeNull();
  });

  it('creates no shadow material for a casting light that has not drawn one', () => {
    const create = vi.spyOn(ShadowBaseNode.prototype, 'getShadowMaterial');
    const scene = new Scene();
    const light = new DirectionalLight();
    new TierShadow(light, 1024).apply(1024);
    scene.add(light, new Mesh(new BoxGeometry(), new MeshBasicNodeMaterial()));

    expect(light.castShadow).toBe(true);
    expect(materialUse(scene, 0)).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('forgets the shadow material once three disposes it', async () => {
    const { scene, light, shadowMaterialId } = await shadowedScene();
    const node = light.shadow.shadowNode;
    if (!(node instanceof ShadowBaseNode)) throw new Error('TierShadow set no shadow node');
    node.disposeShadowMaterial();
    expect(materialUse(scene, shadowMaterialId)).toBeNull();
  });
});

describe('blameEffects', () => {
  const render = (materialId: number | null): PipelineFailure => ({
    kind: 'render',
    materialId,
    message: 'failed',
  });
  const context = (overrides: Partial<FailureContext> = {}): FailureContext => ({
    effects: true,
    dropping: false,
    temporal: false,
    ownedByEffects: (id) => id === 1,
    inScene: (id) => id === 1 || id === 2,
    ...overrides,
  });

  it('blames the effects for their own materials and for materials outside the scene', () => {
    expect(blameEffects(render(1), context())).toBe(true);
    expect(blameEffects(render(3), context())).toBe(true);
  });

  it('blames them when the backend does not name the material, unless a drop is queued', () => {
    expect(blameEffects(render(null), context())).toBe(true);
    expect(blameEffects(render(null), context({ dropping: true }))).toBe(false);
  });

  it('keeps blaming named effects materials while a drop is queued', () => {
    expect(blameEffects(render(1), context({ dropping: true }))).toBe(true);
    expect(blameEffects(render(3), context({ dropping: true }))).toBe(true);
  });

  it('does not blame them for a scene material, unless frames have a velocity output', () => {
    expect(blameEffects(render(2), context())).toBe(false);
    expect(blameEffects(render(2), context({ temporal: true }))).toBe(true);
  });

  it('never blames effects that are not there, nor for a compute pass', () => {
    expect(blameEffects(render(1), context({ effects: false }))).toBe(false);
    expect(blameEffects(render(null), context({ effects: false }))).toBe(false);
    expect(blameEffects({ kind: 'compute', materialId: null, message: 'failed' }, context())).toBe(
      false,
    );
  });
});

describe('PipelineFailureHandler', () => {
  class FakeEffects implements DroppableEffects {
    active = true;
    temporal = false;
    failures: unknown[] = [];

    ownsMaterial(materialId: number): boolean {
      return materialId === 1;
    }

    fail(cause: unknown): void {
      if (!this.active) return;
      this.active = false;
      this.failures.push(cause);
    }
  }

  /** `rebuilds` is how many scene rebuilds are left to try. */
  function setup(rebuilds = 0) {
    const effects = new FakeEffects();
    const reports: { message: string; cause: unknown }[] = [];
    const rebuild = { left: rebuilds, requested: 0 };
    const handler = new PipelineFailureHandler(
      effects,
      (id) => (id === 2 ? 'object' : null),
      (message, cause) => reports.push({ message, cause }),
      () => {
        if (rebuild.left === 0) return false;
        rebuild.left--;
        rebuild.requested++;
        return true;
      },
    );
    return { effects, reports, handler, rebuild };
  }

  const failure = (materialId: number | null, message = 'failed'): PipelineFailure => ({
    kind: 'render',
    materialId,
    message,
  });
  const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

  it('drops the effects after the draw that reported the failure, without reporting it', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(1));
    expect(effects.failures).toEqual([]);
    await settle();
    expect(effects.failures).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('reports a link failure that comes after the effects were dropped, once', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(null, 'post link failed'));
    await settle();
    expect(effects.active).toBe(false);
    handler.handle(failure(null, 'decor link failed'));
    handler.handle(failure(null, 'decor link failed'));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toMatch(/material failed to build/);
    expect(reports[0]?.cause).toEqual(new Error('decor link failed'));
  });

  it('reports an out-of-scene material after the drop, but not the one already blamed', async () => {
    const { reports, handler } = setup();
    handler.handle(failure(5));
    await settle();
    handler.handle(failure(5));
    handler.handle(failure(6));
    expect(reports).toEqual([
      {
        message: 'A pass outside the scene failed to build and is skipped',
        cause: new Error('failed'),
      },
    ]);
  });

  it('drops once and reports an unnamed failure that follows in the same frame', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(null, 'post link failed'));
    handler.handle(failure(null, 'decor link failed'));
    handler.handle(failure(1));
    await settle();
    expect(effects.failures).toEqual([new Error('post link failed')]);
    expect(reports).toEqual([
      {
        message: 'A material failed to build and is not drawn',
        cause: new Error('decor link failed'),
      },
    ]);
  });

  it('tries a scene material without the velocity output before reporting it', async () => {
    const { effects, reports, handler } = setup();
    effects.temporal = true;
    handler.handle(failure(2, 'velocity'));
    handler.handle(failure(2, 'velocity'));
    await settle();
    expect(effects.failures).toEqual([new Error('velocity')]);
    expect(reports).toEqual([]);

    handler.handle(failure(2, 'plain'));
    handler.handle(failure(2, 'plain'));
    expect(reports).toEqual([
      { message: 'A material failed to build and is not drawn', cause: new Error('plain') },
    ]);
  });

  it('keeps a scene material quiet when it builds without the velocity output', async () => {
    const { effects, reports, handler } = setup();
    effects.temporal = true;
    handler.handle(failure(2));
    await settle();
    expect(effects.active).toBe(false);
    expect(reports).toEqual([]);
  });

  it('keeps the effects own materials quiet after the drop', async () => {
    const { effects, reports, handler } = setup();
    effects.temporal = true;
    handler.handle(failure(1));
    await settle();
    handler.handle(failure(1));
    expect(reports).toEqual([]);
  });

  it('reports a scene material once while keeping the effects', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(2));
    handler.handle(failure(2));
    await settle();
    expect(effects.active).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it('keeps the effects when a scene material reported before fails again under TRAA', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(2));
    effects.temporal = true;
    handler.handle(failure(2));
    await settle();
    expect(effects.failures).toEqual([]);
    expect(effects.active).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it('drops effects attached again after a drop when they fail in turn', async () => {
    const { effects, reports, handler } = setup();
    handler.handle(failure(null, 'submit used a destroyed texture'));
    await settle();
    effects.active = true;
    handler.handle(failure(null, 'post link failed'));
    await settle();
    expect(effects.failures).toEqual([
      new Error('submit used a destroyed texture'),
      new Error('post link failed'),
    ]);
    expect(reports).toEqual([]);
  });

  const destroyedShadow =
    'WebGPURenderer: Async render pipeline creation failed (renderPipeline_fish:angelfish_2): ' +
    'Destroyed texture [Texture "ShadowDepthTexture"] used in a submit.';

  it('rebuilds a scene material hit by a transient failure instead of hiding or reporting it', async () => {
    const { effects, reports, handler, rebuild } = setup(3);
    handler.handle(failure(2, destroyedShadow));
    await settle();
    expect(rebuild.requested).toBe(1);
    expect(effects.failures).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('rebuilds the scene and keeps the effects for a transient failure it cannot name', async () => {
    const { effects, reports, handler, rebuild } = setup(3);
    handler.handle(failure(null, destroyedShadow));
    await settle();
    expect(rebuild.requested).toBe(1);
    expect(effects.failures).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('rebuilds the scene for a transient failure of its shadow pass', async () => {
    const { scene, shadowMaterialId } = await shadowedScene();
    const effects = new FakeEffects();
    const reports: string[] = [];
    let rebuilds = 0;
    const handler = new PipelineFailureHandler(
      effects,
      (id) => materialUse(scene, id),
      (message) => reports.push(message),
      () => {
        rebuilds++;
        return true;
      },
    );

    handler.handle(failure(shadowMaterialId, destroyedShadow));
    await settle();
    expect(rebuilds).toBe(1);
    expect(effects.failures).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('reports a lasting failure of the shadow pass as a missing shadow', async () => {
    const { scene, shadowMaterialId } = await shadowedScene();
    const effects = new FakeEffects();
    const reports: string[] = [];
    const handler = new PipelineFailureHandler(
      effects,
      (id) => materialUse(scene, id),
      (message) => reports.push(message),
      () => false,
    );

    handler.handle(failure(shadowMaterialId, 'error: unresolved identifier'));
    await settle();
    expect(effects.active).toBe(true);
    expect(reports).toEqual(["An object's shadow failed to build and is not drawn"]);
  });

  it('never rebuilds the scene for a transient failure of a pass outside it', async () => {
    const { effects, reports, handler, rebuild } = setup(3);
    handler.handle(failure(7, destroyedShadow));
    await settle();
    expect(rebuild.requested).toBe(0);
    expect(effects.failures).toEqual([new Error(destroyedShadow)]);
    expect(reports).toEqual([]);

    handler.handle(failure(8, destroyedShadow));
    expect(rebuild.requested).toBe(0);
    expect(reports.map((r) => r.message)).toEqual([
      'A pass outside the scene failed to build and is skipped',
    ]);
  });

  it('leaves a transient failure in the effects own passes to their recovery', async () => {
    const { effects, handler, rebuild } = setup(3);
    handler.handle(failure(1, destroyedShadow));
    await settle();
    expect(rebuild.requested).toBe(0);
    expect(effects.failures).toEqual([new Error(destroyedShadow)]);
  });

  it('reports a scene material once rebuilding stops helping', async () => {
    const { effects, reports, handler, rebuild } = setup(1);
    handler.handle(failure(2, destroyedShadow));
    handler.handle(failure(2, destroyedShadow));
    await settle();
    expect(rebuild.requested).toBe(1);
    expect(effects.active).toBe(true);
    expect(reports.map((r) => r.message)).toEqual(['A material failed to build and is not drawn']);
  });

  it('never rebuilds for a real shader error', async () => {
    const { reports, handler, rebuild } = setup(3);
    handler.handle(failure(2, 'error: unresolved identifier'));
    await settle();
    expect(rebuild.requested).toBe(0);
    expect(reports).toHaveLength(1);
  });

  it('reports a compute failure once by its message', () => {
    const { effects, reports, handler } = setup();
    const compute: PipelineFailure = { kind: 'compute', materialId: null, message: 'bad' };
    handler.handle(compute);
    handler.handle(compute);
    expect(effects.active).toBe(true);
    expect(reports.map((r) => r.message)).toEqual([
      'A GPU compute pass failed to build and does not run',
    ]);
  });
});
