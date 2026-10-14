import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type CoordinateSystem,
  type Vector2,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  mirrorCamera,
  SurfaceReflection,
  UNREFLECTED_LAYER,
  WATERLINE_MARGIN,
} from './surfaceReflection';

const LEVEL = 0.47;

function sceneCamera(coordinateSystem: CoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 50);
  camera.coordinateSystem = coordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.set(0.1, 0.41, 1.6);
  camera.lookAt(-0.05, 0.3, 0);
  camera.updateMatrixWorld();
  return camera;
}

function mirrored(p: Vector3): Vector3 {
  return new Vector3(p.x, 2 * LEVEL - p.y, p.z);
}

describe.each([
  ['WebGL', WebGLCoordinateSystem, -1],
  ['WebGPU', WebGPUCoordinateSystem, 0],
] as const)('mirrorCamera (%s)', (_name, coordinateSystem, nearDepth) => {
  const camera = sceneCamera(coordinateSystem);
  const virtual = new PerspectiveCamera();
  mirrorCamera(camera, LEVEL, virtual, coordinateSystem);

  it('sits at the camera mirrored in the surface', () => {
    const at = new Vector3().setFromMatrixPosition(virtual.matrixWorld);
    expect(at.x).toBeCloseTo(0.1, 6);
    expect(at.y).toBeCloseTo(2 * LEVEL - 0.41, 6);
    expect(at.z).toBeCloseTo(1.6, 6);
  });

  it('shows a point under water where the camera sees its mirror image, flipped left to right', () => {
    for (const p of [new Vector3(0.2, 0.3, -0.1), new Vector3(-0.3, 0.05, 0.1)]) {
      const direct = mirrored(p).project(camera);
      const reflected = p.clone().project(virtual);
      expect(reflected.x).toBeCloseTo(-direct.x, 5);
      expect(reflected.y).toBeCloseTo(direct.y, 5);
      expect(reflected.z).toBeGreaterThan(nearDepth);
      expect(reflected.z).toBeLessThan(1);
    }
  });

  it('clips what lies above the surface at its near plane', () => {
    const above = new Vector3(0, LEVEL + 0.05, -0.1).project(virtual);
    expect(above.z).toBeLessThan(nearDepth);
    const onSurface = new Vector3(0.1, LEVEL, -0.15).project(virtual);
    expect(onSurface.z).toBeCloseTo(nearDepth, 4);
  });

  it('keeps the projection inverse in step with the oblique projection', () => {
    const product = virtual.projectionMatrix.clone().multiply(virtual.projectionMatrixInverse);
    product.elements.forEach((value, i) => expect(value).toBeCloseTo(i % 5 === 0 ? 1 : 0, 6));
  });
});

describe('mirrorCamera depth', () => {
  const POINTS = [
    new Vector3(0.2, 0.3, -0.1),
    new Vector3(-0.3, 0.05, 0.1),
    new Vector3(0, 0.4, -0.15),
  ];

  function depths(coordinateSystem: CoordinateSystem): number[] {
    const virtual = new PerspectiveCamera();
    mirrorCamera(sceneCamera(coordinateSystem), LEVEL, virtual, coordinateSystem);
    return POINTS.map((p) => p.clone().project(virtual).z);
  }

  it('spreads WebGL depth over the whole [-1, 1] range, as WebGPU spreads it over [0, 1]', () => {
    const gl = depths(WebGLCoordinateSystem);
    const gpu = depths(WebGPUCoordinateSystem);
    gl.forEach((z, i) => expect(z).toBeCloseTo(2 * (gpu[i] ?? Number.NaN) - 1, 5));
  });
});

/** Records what the reflection does to the renderer, and restores nothing on its own. */
function fakeRenderer(): {
  renderer: WebGPURenderer;
  rendered: Camera[];
  compiled: { camera: Camera; target: unknown; mrt: unknown }[];
  state: { target: unknown; mrt: unknown };
  finishCompile: () => void;
} {
  let finishCompile = (): void => undefined;
  const state: { target: unknown; mrt: unknown } = { target: null, mrt: null };
  const rendered: Camera[] = [];
  const compiled: { camera: Camera; target: unknown; mrt: unknown }[] = [];
  const renderer = {
    coordinateSystem: WebGPUCoordinateSystem,
    autoClear: false,
    init: () => Promise.resolve(),
    getDrawingBufferSize: (out: Vector2) => out.set(1600, 900),
    getRenderTarget: () => state.target,
    setRenderTarget: (target: unknown) => {
      state.target = target;
    },
    getMRT: () => state.mrt,
    setMRT: (mrt: unknown) => {
      state.mrt = mrt;
    },
    render: (_scene: Scene, camera: Camera) => rendered.push(camera),
    compileAsync: (_scene: Scene, camera: Camera) => {
      compiled.push({ camera, target: state.target, mrt: state.mrt });
      return new Promise<void>((resolve) => (finishCompile = resolve));
    },
  };
  return {
    renderer: renderer as unknown as WebGPURenderer,
    rendered,
    compiled,
    state,
    finishCompile: () => finishCompile(),
  };
}

describe('SurfaceReflection', () => {
  const surface = new Box3(new Vector3(-0.5, LEVEL, -0.2), new Vector3(0.5, LEVEL, 0.2));

  function cameraAt(y: number): PerspectiveCamera {
    const camera = sceneCamera(WebGPUCoordinateSystem);
    camera.position.y = y;
    camera.lookAt(0, LEVEL, 0);
    camera.updateMatrixWorld();
    return camera;
  }

  it('draws below the surface and skips the pass while the camera crosses the waterline', () => {
    const reflection = new SurfaceReflection(surface);
    reflection.setResolutionScale(0.5);
    const { renderer, rendered } = fakeRenderer();
    const scene = new Scene();

    reflection.render(renderer, scene, cameraAt(LEVEL - 0.1));
    expect(rendered).toHaveLength(1);
    reflection.render(renderer, scene, cameraAt(LEVEL - WATERLINE_MARGIN / 2));
    reflection.render(renderer, scene, cameraAt(LEVEL + WATERLINE_MARGIN / 2));
    reflection.render(renderer, scene, cameraAt(LEVEL + 0.1));
    expect(rendered).toHaveLength(1);
    reflection.dispose();
  });

  it('compiles its pass into its own target and gives the renderer back at once', async () => {
    const reflection = new SurfaceReflection(surface);
    const { renderer, compiled, state, finishCompile } = fakeRenderer();
    const scene = new Scene();
    const camera = cameraAt(LEVEL + 0.3);
    camera.layers.enable(UNREFLECTED_LAYER);

    await reflection.compile(renderer, scene, camera);
    expect(compiled).toEqual([]);

    reflection.setResolutionScale(1);
    const sceneTarget = { name: 'scene' };
    state.target = sceneTarget;
    const done = vi.fn();
    const compiling = reflection.compile(renderer, scene, camera).then(done);
    await vi.waitFor(() => expect(compiled).toHaveLength(1));
    expect(done).not.toHaveBeenCalled();
    expect(state.target).toBe(sceneTarget);
    expect(state.mrt).toBeNull();
    finishCompile();
    await compiling;
    expect(done).toHaveBeenCalledOnce();

    const [pass] = compiled;
    expect(pass?.target).not.toBe(sceneTarget);
    expect(pass?.target).not.toBeNull();
    expect(pass?.mrt).not.toBeNull();
    expect(pass?.camera).not.toBe(camera);
    expect(pass?.camera.layers.isEnabled(UNREFLECTED_LAYER)).toBe(false);
    expect(pass?.camera.layers.isEnabled(0)).toBe(true);
    reflection.dispose();
  });

  it('starts off and turns on with a positive resolution scale', () => {
    const reflection = new SurfaceReflection(surface);
    expect(reflection.enabled).toBe(false);
    reflection.setResolutionScale(0.5);
    expect(reflection.enabled).toBe(true);
    reflection.setResolutionScale(0);
    expect(reflection.enabled).toBe(false);
    reflection.dispose();
  });

  it.each([-0.1, 1.5, Number.NaN])('rejects a resolution scale of %s', (scale) => {
    const reflection = new SurfaceReflection(surface);
    expect(() => reflection.setResolutionScale(scale)).toThrow(RangeError);
    expect(reflection.enabled).toBe(false);
  });
});
