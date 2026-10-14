import {
  getConsoleFunction,
  Material,
  setConsoleFunction,
  type Object3D,
  type WebGPURenderer,
} from 'three/webgpu';

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

/**
 * Hears every pipeline three fails to build: on WebGPU through three's console, which still
 * prints as before, and on WebGL through its shader error hook. Returns the undo.
 */
export function watchPipelineErrors(
  renderer: Pick<WebGPURenderer, 'debug'>,
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

  const previousShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    const message = linkFailureMessage(gl, program, vertex, fragment);
    if (previousShaderError === null) forward('error', message);
    else previousShaderError(gl, program, vertex, fragment);
    onFailure({ kind: 'render', materialId: null, message });
  };

  return () => {
    if (getConsoleFunction() === watcher) setConsoleFunction(forward);
    renderer.debug.onShaderError = previousShaderError;
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
  ownedByEffects(materialId: number): boolean;
  inScene(materialId: number): boolean;
}

/**
 * Whether a failure is the effects' to answer for, by dropping them for the plain render. Their
 * post passes draw materials that are not in the scene; so do shadow maps, which this cannot tell
 * apart, but the plain render is the safe answer to those too. WebGL does not name the material.
 */
export function blameEffects(failure: PipelineFailure, context: FailureContext): boolean {
  if (!context.effects || failure.kind === 'compute') return false;
  const id = failure.materialId;
  return id === null || context.ownedByEffects(id) || !context.inScene(id);
}

/** The engine's effects, as far as answering a pipeline failure goes. */
export interface DroppableEffects {
  readonly active: boolean;
  ownsMaterial(materialId: number): boolean;
  /** Drops the effects; does nothing once they are gone. */
  fail(cause: unknown): void;
}

export type ReportFailure = (message: string, cause: unknown) => void;

/**
 * Answers each pipeline failure once: by dropping the effects while that can still help, otherwise
 * by reporting it. Only the materials already blamed on dropped effects stay quiet afterwards, as
 * their pending builds may still fail; any other failure is reported, whatever came before.
 */
export class PipelineFailureHandler {
  private readonly blamed = new Set<number>();
  private readonly reported = new Set<number | string>();

  constructor(
    private readonly effects: DroppableEffects,
    private readonly inScene: (materialId: number) => boolean,
    private readonly report: ReportFailure,
  ) {}

  handle(failure: PipelineFailure): void {
    const id = failure.materialId;
    if (id !== null && this.blamed.has(id)) return;
    const cause = new Error(failure.message);
    const context: FailureContext = {
      effects: this.effects.active,
      ownedByEffects: (materialId) => this.effects.ownsMaterial(materialId),
      inScene: this.inScene,
    };
    if (blameEffects(failure, context)) {
      if (id !== null) this.blamed.add(id);
      // WebGL reports from inside the draw; tearing the post chain down mid-render is not safe.
      queueMicrotask(() => this.effects.fail(cause));
      return;
    }
    const key = id ?? failure.message;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.report(
      failure.kind === 'compute'
        ? 'A GPU compute pass failed to build and does not run'
        : 'A material failed to build and is not drawn',
      cause,
    );
  }
}
