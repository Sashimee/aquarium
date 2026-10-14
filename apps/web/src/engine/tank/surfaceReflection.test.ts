import { describe, expect, it } from 'vitest';
import {
  Box3,
  PerspectiveCamera,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type CoordinateSystem,
} from 'three/webgpu';
import { mirrorCamera, SurfaceReflection } from './surfaceReflection';

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

describe('SurfaceReflection', () => {
  const surface = new Box3(new Vector3(-0.5, LEVEL, -0.2), new Vector3(0.5, LEVEL, 0.2));

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
