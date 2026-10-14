import { afterEach, describe, expect, it } from 'vitest';
import {
  getConsoleFunction,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Scene,
  setConsoleFunction,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  blameEffects,
  linkFailureMessage,
  materialIdOf,
  parsePipelineFailure,
  usesMaterial,
  watchPipelineErrors,
  type FailureContext,
  type PipelineFailure,
} from './pipelineErrors';

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
  const logs = (program: string | null, vertex: string | null, fragment: string | null) => {
    const vertexShader = {};
    return {
      gl: {
        getProgramInfoLog: () => program,
        getShaderInfoLog: (shader: WebGLShader) => (shader === vertexShader ? vertex : fragment),
      },
      vertexShader,
    };
  };

  it('joins the info logs that say something', () => {
    const { gl, vertexShader } = logs('link failed\n', null, "  ERROR: 'foo' undeclared ");
    expect(linkFailureMessage(gl, {}, vertexShader, {})).toBe(
      "WebGL program failed to link\nlink failed\nERROR: 'foo' undeclared",
    );
  });

  it('still names the failure when every log is empty', () => {
    const { gl, vertexShader } = logs('', '', null);
    expect(linkFailureMessage(gl, {}, vertexShader, {})).toBe('WebGL program failed to link');
  });
});

function fakeRenderer(): Pick<WebGPURenderer, 'debug'> {
  return {
    debug: {
      checkShaderErrors: true,
      diagnostics: { keywords: false },
      onNodeBuilderCreated: null,
      onShaderError: null,
      getShaderAsync: () => Promise.resolve({ fragmentShader: null, vertexShader: null }),
    },
  };
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
});

describe('usesMaterial', () => {
  it('finds a material on a hidden, nested object and in a material array', () => {
    const scene = new Scene();
    const hiddenMaterial = new MeshBasicNodeMaterial();
    const arrayMaterial = new MeshStandardNodeMaterial();
    const group = new Group();
    const hidden = new Mesh(undefined, hiddenMaterial);
    hidden.visible = false;
    group.add(hidden);
    scene.add(group, new Mesh(undefined, [new MeshBasicNodeMaterial(), arrayMaterial]));

    expect(usesMaterial(scene, materialIdOf(hiddenMaterial) ?? -1)).toBe(true);
    expect(usesMaterial(scene, materialIdOf(arrayMaterial) ?? -1)).toBe(true);
    expect(usesMaterial(scene, materialIdOf(new MeshBasicNodeMaterial()) ?? -1)).toBe(false);
  });

  it('finds nothing in an empty scene', () => {
    expect(usesMaterial(new Scene(), 0)).toBe(false);
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
    ownedByEffects: (id) => id === 1,
    inScene: (id) => id === 1 || id === 2,
    ...overrides,
  });

  it('blames the effects for their own materials and for materials outside the scene', () => {
    expect(blameEffects(render(1), context())).toBe(true);
    expect(blameEffects(render(3), context())).toBe(true);
  });

  it('blames them when the backend does not name the material', () => {
    expect(blameEffects(render(null), context())).toBe(true);
  });

  it('does not blame them for a scene material', () => {
    expect(blameEffects(render(2), context())).toBe(false);
  });

  it('never blames effects that are not there, nor for a compute pass', () => {
    expect(blameEffects(render(1), context({ effects: false }))).toBe(false);
    expect(blameEffects(render(null), context({ effects: false }))).toBe(false);
    expect(blameEffects({ kind: 'compute', materialId: null, message: 'failed' }, context())).toBe(
      false,
    );
  });
});
