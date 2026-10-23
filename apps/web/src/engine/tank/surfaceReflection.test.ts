import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type Camera,
  type CoordinateSystem,
  type MRTNode,
  type Object3D,
  type Vector2,
} from 'three/webgpu';
import { float, uniform } from 'three/tsl';
import { evaluate } from '../shaderFixtures';
import {
  blendCoverage,
  COVERAGE_FALLOFF,
  mirrorCamera,
  SurfaceReflection,
  TANK_TOLERANCE,
  tankCoverage,
  type ReflectionRenderer,
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
interface PassState {
  target: RenderTarget | null;
  mrt: MRTNode | null;
}

function fakeRenderer(): {
  renderer: ReflectionRenderer;
  rendered: Camera[];
  compiled: (PassState & { camera: Camera })[];
  state: PassState;
  finishCompile: () => void;
} {
  let finishCompile = (): void => undefined;
  const state: PassState = { target: null, mrt: null };
  const rendered: Camera[] = [];
  const compiled: (PassState & { camera: Camera })[] = [];
  const renderer: ReflectionRenderer = {
    coordinateSystem: WebGPUCoordinateSystem,
    autoClear: false,
    init: () => Promise.resolve(),
    getDrawingBufferSize: (out: Vector2) => out.set(1600, 900),
    getRenderTarget: () => state.target,
    setRenderTarget: (target) => {
      state.target = target;
    },
    getMRT: () => state.mrt,
    setMRT: (mrt) => {
      state.mrt = mrt;
    },
    render: (_scene: Object3D, camera: Camera) => {
      rendered.push(camera);
    },
    compileAsync: (_scene: Object3D, camera: Camera) => {
      compiled.push({ camera, target: state.target, mrt: state.mrt });
      return new Promise<void>((resolve) => (finishCompile = resolve));
    },
  };
  return {
    renderer,
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

    expect(reflection.render(renderer, scene, cameraAt(LEVEL - 0.1))).toBe(true);
    expect(rendered).toHaveLength(1);
    expect(reflection.render(renderer, scene, cameraAt(LEVEL - WATERLINE_MARGIN / 2))).toBe(false);
    expect(reflection.render(renderer, scene, cameraAt(LEVEL + WATERLINE_MARGIN / 2))).toBe(false);
    expect(reflection.render(renderer, scene, cameraAt(LEVEL + 0.1))).toBe(false);
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
    const sceneTarget = new RenderTarget(1, 1);
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

  // The compile view ignores the camera's pose; only its clip planes reach it.
  it.each([
    ['the scene camera', 0.05, 50],
    ['a camera with a near plane beyond the surface', 0.6, 50],
    ['a camera with a close far plane', 0.01, 2],
  ] as const)(
    'compiles a view of the whole tank floor whatever the camera clips (%s)',
    async (_name, near, far) => {
      const reflection = new SurfaceReflection(surface);
      reflection.setResolutionScale(0.5);
      const { renderer, compiled, finishCompile } = fakeRenderer();
      const camera = sceneCamera(WebGPUCoordinateSystem);
      camera.near = near;
      camera.far = far;
      camera.position.set(0.2, LEVEL + 0.3, 1.6);
      camera.lookAt(0, LEVEL + 0.3, 5);
      camera.updateProjectionMatrix();
      const compiling = reflection.compile(renderer, new Scene(), camera);
      await vi.waitFor(() => expect(compiled).toHaveLength(1));
      finishCompile();
      await compiling;

      const view = compiled[0]?.camera;
      if (!(view instanceof PerspectiveCamera)) throw new Error('expected a perspective camera');
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse),
        WebGPUCoordinateSystem,
      );
      for (const cx of [surface.min.x, surface.max.x]) {
        for (const cz of [surface.min.z, surface.max.z]) {
          expect(frustum.containsPoint(new Vector3(cx, 0, cz))).toBe(true);
          expect(frustum.containsPoint(new Vector3(cx, LEVEL, cz))).toBe(true);
        }
      }
      reflection.dispose();
    },
  );

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

describe('tankCoverage', () => {
  const boxMin = uniform(new Vector3(-0.5, 0.01, -0.2));
  const boxMax = uniform(new Vector3(0.5, 0.45, 0.2));

  function coverage(x: number, y: number, z: number): number {
    const [c] = evaluate(tankCoverage(uniform(new Vector3(x, y, z)), boxMin, boxMax));
    if (c === undefined) throw new Error('tankCoverage evaluated to nothing');
    return c;
  }

  it('counts the water, the glass and the backdrop behind the back pane as the tank', () => {
    expect(coverage(0, 0.2, 0)).toBe(1);
    expect(coverage(0.5, 0.01, -0.2)).toBe(1);
    expect(coverage(0.2, 0.3, -0.2 - TANK_TOLERANCE)).toBeCloseTo(1, 9);
    expect(coverage(-0.5 - TANK_TOLERANCE, 0.3, 0)).toBeCloseTo(1, 9);
  });

  it('fades linearly to nothing over the falloff past the tolerance', () => {
    const half = coverage(0.5 + TANK_TOLERANCE + COVERAGE_FALLOFF / 2, 0.3, 0);
    expect(half).toBeCloseTo(0.5, 6);
    let previous = 1;
    for (let d = 0; d <= TANK_TOLERANCE + COVERAGE_FALLOFF * 1.5; d += 0.005) {
      const c = coverage(0, 0.3, 0.2 + d);
      expect(c).toBeLessThanOrEqual(previous);
      expect(c).toBeGreaterThanOrEqual(0);
      previous = c;
    }
    expect(coverage(0.5 + TANK_TOLERANCE + COVERAGE_FALLOFF, 0.3, 0)).toBeCloseTo(0, 9);
  });

  it('gives the room and the far plane, seen through an undrawn pane, nothing', () => {
    expect(coverage(1.5, 0.3, 0.1)).toBe(0);
    expect(coverage(0, -0.4, 3)).toBe(0);
    expect(coverage(-40, -20, -30)).toBe(0);
  });
});

describe('blendCoverage', () => {
  const fallback = uniform(new Vector3(0.1, 0.2, 0.3));

  function blend(colour: [number, number, number], covered: number, taps: number): number[] {
    return evaluate(blendCoverage(uniform(new Vector3(...colour)), float(covered), fallback, taps));
  }

  it('shows the pass where every tap is covered', () => {
    const mirror = blend([2.5, 5, 7.5], 5, 5);
    [0.5, 1, 1.5].forEach((v, i) => expect(mirror[i]).toBeCloseTo(v, 9));
  });

  it('shows the fallback where no tap is', () => {
    const mirror = blend([0, 0, 0], 0, 5);
    [0.1, 0.2, 0.3].forEach((v, i) => expect(mirror[i]).toBeCloseTo(v, 9));
  });

  it('mixes the two by the covered share across an edge', () => {
    const mirror = blend([1, 1, 1], 2, 4);
    [0.25 + 0.05, 0.25 + 0.1, 0.25 + 0.15].forEach((v, i) => expect(mirror[i]).toBeCloseTo(v, 9));
  });
});
