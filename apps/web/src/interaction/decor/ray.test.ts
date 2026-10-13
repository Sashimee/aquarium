import { PerspectiveCamera, Raycaster, Vector2 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { perspectiveRay } from './ray';

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(42, 16 / 9, 0.05, 40);
  cam.position.set(0.4, 0.9, 1.7);
  cam.lookAt(0.1, 0.2, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

describe('perspectiveRay', () => {
  it.each([
    [0, 0],
    [-0.8, 0.5],
    [0.9, -0.7],
  ])('matches three.js Raycaster at ndc (%f, %f)', (x, y) => {
    const cam = camera();
    const caster = new Raycaster();
    caster.setFromCamera(new Vector2(x, y), cam);
    const ray = perspectiveRay(cam, x, y);
    const { origin, direction } = caster.ray;
    expect(ray.origin.x).toBeCloseTo(origin.x, 6);
    expect(ray.origin.y).toBeCloseTo(origin.y, 6);
    expect(ray.origin.z).toBeCloseTo(origin.z, 6);
    expect(ray.dir.x).toBeCloseTo(direction.x, 6);
    expect(ray.dir.y).toBeCloseTo(direction.y, 6);
    expect(ray.dir.z).toBeCloseTo(direction.z, 6);
  });
});
