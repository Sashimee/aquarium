import { getConsoleFunction, Material, setConsoleFunction, type Object3D } from 'three/webgpu';

/**
 * A pipeline three failed to build. It logs the failure and from then on skips every draw that
 * needs the pipeline, so without this the object (or a whole post pass) silently disappears.
 */
export interface PipelineFailure {
  readonly kind: 'render' | 'compute';
  /** The material the render pipeline was for; null when the backend does not say. */
  readonly materialId: number | null;
  readonly message: string;
}

type ConsoleType = 'log' | 'warn' | 'error';
type ConsoleFunction = (type: ConsoleType, message: string, ...params: unknown[]) => void;

const WEBGPU_FAILURE = /WebGPURenderer: (?:Async )?(render|compute) pipeline creation failed \(/i;
/** three labels a render pipeline `renderPipeline_<material name or type>_<material id>`. */
const MATERIAL_ID = /pipeline creation failed \(renderPipeline_.*?_(\d+)\): /i;

/** The failure a three log message reports, or null for any other message. */
export function parsePipelineFailure(message: string): PipelineFailure | null {
  const match = WEBGPU_FAILURE.exec(message);
  if (match === null) return null;
  if (match[1]?.toLowerCase() === 'compute') return { kind: 'compute', materialId: null, message };
  const id = MATERIAL_ID.exec(message)?.[1];
  return { kind: 'render', materialId: id === undefined ? null : Number(id), message };
}

interface StackTrace {
  readonly isStackTrace: true;
  getError(message: string): Error;
}

function isStackTrace(value: unknown): value is StackTrace {
  return typeof value === 'object' && value !== null && 'isStackTrace' in value;
}

/** What three does with a message when no console function is set. */
function nativeConsole(type: ConsoleType, message: string, ...params: unknown[]): void {
  const [first] = params;
  if (isStackTrace(first)) console[type](first.getError(message));
  else console[type](message, ...params);
}

export type ShaderLogs = Pick<
  WebGL2RenderingContext,
  | 'COMPILE_STATUS'
  | 'getProgramInfoLog'
  | 'getShaderInfoLog'
  | 'getShaderParameter'
  | 'getShaderSource'
>;

const SOURCE_CONTEXT_LINES = 6;

/** The lines around `errorLine` (1-based), the failing one marked, as three prints them. */
function sourceExcerpt(source: string, errorLine: number): string {
  const lines = source.split('\n');
  const from = Math.max(errorLine - SOURCE_CONTEXT_LINES, 0);
  const to = Math.min(errorLine + SOURCE_CONTEXT_LINES, lines.length);
  return lines
    .slice(from, to)
    .map((text, i) => {
      const line = from + i + 1;
      return `${line === errorLine ? '>' : ' '} ${line}: ${text}`;
    })
    .join('\n');
}

/** A shader's compile errors with the source around the first one; empty when it compiled. */
function shaderErrors(gl: ShaderLogs, shader: WebGLShader, stage: 'vertex' | 'fragment'): string {
  const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true;
  const errors = (gl.getShaderInfoLog(shader) ?? '').trim();
  if (compiled && errors === '') return '';
  const errorLine = /ERROR: 0:(\d+)/.exec(errors)?.[1];
  const source = gl.getShaderSource(shader);
  if (errorLine === undefined || source === null) return errors;
  return `${stage.toUpperCase()}\n\n${errors}\n\n${sourceExcerpt(source, Number(errorLine))}`;
}

/**
 * The report three prints for a WebGL program that failed to link, which `onShaderError`
 * replaces: the program log and each stage's errors with the failing source line marked.
 */
export function linkFailureMessage(
  gl: ShaderLogs,
  program: WebGLProgram,
  vertex: WebGLShader,
  fragment: WebGLShader,
): string {
  return [
    'THREE.WebGLProgram: Shader Error - program failed to link',
    `Program Info Log: ${(gl.getProgramInfoLog(program) ?? '').trim()}`,
    shaderErrors(gl, vertex, 'vertex'),
    shaderErrors(gl, fragment, 'fragment'),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

interface LinkedMaterial {
  current(): number | null;
  restore(): void;
}

/**
 * WebGL's shader error hook does not say which material failed. Its backend links every render
 * program in `_completeCompile(renderObject, pipeline)`, at once or from a later frame, and the hook
 * runs inside it, so the material is known for that call. Without the method it stays unknown.
 */
function trackLinkedMaterial(backend: object): LinkedMaterial {
  const original: unknown = Reflect.get(backend, '_completeCompile');
  if (typeof original !== 'function') return { current: () => null, restore: () => undefined };
  const hadOwn = Object.hasOwn(backend, '_completeCompile');
  let current: number | null = null;
  const wrapped = function (this: unknown, renderObject: unknown, ...rest: unknown[]): unknown {
    const previous = current;
    current = materialIdOfRenderObject(renderObject);
    try {
      return Reflect.apply(original, this, [renderObject, ...rest]);
    } finally {
      current = previous;
    }
  };
  Reflect.set(backend, '_completeCompile', wrapped);
  return {
    current: () => current,
    restore: () => {
      if (Reflect.get(backend, '_completeCompile') !== wrapped) return;
      if (hadOwn) Reflect.set(backend, '_completeCompile', original);
      else Reflect.deleteProperty(backend, '_completeCompile');
    },
  };
}

function materialIdOfRenderObject(renderObject: unknown): number | null {
  if (typeof renderObject !== 'object' || renderObject === null) return null;
  const material: unknown = Reflect.get(renderObject, 'material');
  return material instanceof Material ? materialIdOf(material) : null;
}

type ShaderErrorHook<GL> = (
  gl: GL,
  program: WebGLProgram,
  vertex: WebGLShader,
  fragment: WebGLShader,
) => void;

/** The renderer as far as watching it goes; `GL` is WebGL2RenderingContext on a real one. */
export interface WatchedRenderer<GL extends ShaderLogs> {
  readonly backend: object;
  readonly debug: { onShaderError: ShaderErrorHook<GL> | null };
}

/**
 * Hears every pipeline three fails to build: on WebGPU through three's console, which still
 * prints as before, and on WebGL through its shader error hook. Returns the undo.
 */
export function watchPipelineErrors<GL extends ShaderLogs>(
  renderer: WatchedRenderer<GL>,
  onFailure: (failure: PipelineFailure) => void,
): () => void {
  const previous: ConsoleFunction | null = getConsoleFunction();
  const forward = previous ?? nativeConsole;
  const watcher: ConsoleFunction = (type, message, ...params) => {
    forward(type, message, ...params);
    if (type !== 'error' || typeof message !== 'string') return;
    const failure = parsePipelineFailure(message);
    if (failure !== null) onFailure(failure);
  };
  setConsoleFunction(watcher);

  const linked = trackLinkedMaterial(renderer.backend);
  const previousShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    const message = linkFailureMessage(gl, program, vertex, fragment);
    if (previousShaderError === null) forward('error', message);
    else previousShaderError(gl, program, vertex, fragment);
    onFailure({ kind: 'render', materialId: linked.current(), message });
  };

  return () => {
    if (getConsoleFunction() === watcher) setConsoleFunction(forward);
    renderer.debug.onShaderError = previousShaderError;
    linked.restore();
  };
}

/** The id three labels the material's pipelines with, which @types/three 0.186 does not declare. */
export function materialIdOf(material: Material): number | null {
  return 'id' in material && typeof material.id === 'number' ? material.id : null;
}

/** Whether any object under `root`, hidden ones included, draws with material `id`. */
export function usesMaterial(root: Object3D, id: number): boolean {
  let found = false;
  root.traverse((object) => {
    if (found || !('material' in object)) return;
    const material: unknown = object.material;
    const materials: unknown[] = Array.isArray(material) ? material : [material];
    found = materials.some((m) => m instanceof Material && materialIdOf(m) === id);
  });
  return found;
}

export interface FailureContext {
  /** Effects are attached now, so dropping them can still help. */
  readonly effects: boolean;
  /** A drop is already queued for an earlier failure. */
  readonly dropping: boolean;
  /** Frames go through a temporal resolve, which gives every scene material a velocity output. */
  readonly temporal: boolean;
  ownedByEffects(materialId: number): boolean;
  inScene(materialId: number): boolean;
}

/**
 * Whether a failure is the effects' to answer for, by dropping them for the plain render. Their
 * post passes draw materials that are not in the scene; so do shadow maps, which this cannot tell
 * apart, but the plain render is the safe answer to those too. Under a temporal resolve a scene
 * material may fail only for the velocity output, so the plain render is tried for it as well. An
 * unnamed failure is put on the effects only once: the next one may be a scene material.
 */
export function blameEffects(failure: PipelineFailure, context: FailureContext): boolean {
  if (!context.effects || failure.kind === 'compute') return false;
  const id = failure.materialId;
  if (id === null) return !context.dropping;
  return context.ownedByEffects(id) || !context.inScene(id) || context.temporal;
}

/** The engine's effects, as far as answering a pipeline failure goes. */
export interface DroppableEffects {
  readonly active: boolean;
  readonly temporal: boolean;
  ownsMaterial(materialId: number): boolean;
  /** Drops the effects; does nothing once they are gone. */
  fail(cause: unknown): void;
}

export type ReportFailure = (message: string, cause: unknown) => void;

/**
 * Answers each pipeline failure once: by dropping the effects while that can still help, otherwise
 * by reporting it. The materials blamed on dropped effects stay quiet afterwards, as their pending
 * builds may still fail, except a scene material, which is reported if it fails without them too.
 * A material already reported is broken without the effects' help, so it never drops them.
 *
 * The engine rebuilds dropped effects only after a transient failure, so under a temporal resolve
 * (ultra) one broken scene material costs the post effects for the session: only the plain render
 * tells it from a velocity-only failure. On WebGPU that test can misfire: failures arrive
 * asynchronously, labelled by material alone, so a late one from the earlier velocity build reads
 * as the plain one failing.
 */
export class PipelineFailureHandler {
  private dropping = false;
  private readonly blamed = new Set<number>();
  /** Scene materials blamed on the velocity output, until they fail without effects too. */
  private readonly suspects = new Set<number>();
  private readonly reported = new Set<number | string>();

  constructor(
    private readonly effects: DroppableEffects,
    private readonly inScene: (materialId: number) => boolean,
    private readonly report: ReportFailure,
  ) {}

  handle(failure: PipelineFailure): void {
    const id = failure.materialId;
    const cause = new Error(failure.message);
    if (id !== null && this.reported.has(id)) return;
    if (id !== null && this.blamed.has(id)) {
      if (this.effects.active || !this.suspects.has(id)) return;
      this.suspects.delete(id);
    } else if (this.blame(failure, cause)) {
      return;
    }
    const key = id ?? failure.message;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.report(reportMessage(failure, id !== null && !this.inScene(id)), cause);
  }

  private blame(failure: PipelineFailure, cause: Error): boolean {
    const context: FailureContext = {
      effects: this.effects.active,
      dropping: this.dropping,
      temporal: this.effects.temporal,
      ownedByEffects: (materialId) => this.effects.ownsMaterial(materialId),
      inScene: this.inScene,
    };
    if (!blameEffects(failure, context)) return false;
    const id = failure.materialId;
    if (id !== null) {
      this.blamed.add(id);
      if (this.inScene(id) && !this.effects.ownsMaterial(id)) this.suspects.add(id);
    }
    if (!this.dropping) {
      this.dropping = true;
      // WebGL reports from inside the draw; tearing the post chain down mid-render is not safe.
      queueMicrotask(() => {
        try {
          this.effects.fail(cause);
        } finally {
          // Effects attached again later are answered for afresh.
          this.dropping = false;
        }
      });
    }
    return true;
  }
}

function reportMessage(failure: PipelineFailure, outsideScene: boolean): string {
  if (failure.kind === 'compute') return 'A GPU compute pass failed to build and does not run';
  // Left over from dropped effects or a shadow map: nothing tells the two apart.
  if (outsideScene) return 'A pass outside the scene failed to build and is skipped';
  return 'A material failed to build and is not drawn';
}
