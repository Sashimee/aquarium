import {
  Box3,
  Frustum,
  HalfFloatType,
  Matrix4,
  PerspectiveCamera,
  Plane,
  RenderTarget,
  Vector2,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
  type CoordinateSystem,
  type Node,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { mrt, output, screenUV, texture } from 'three/tsl';

/** Objects on this layer are drawn by the scene camera but left out of the surface reflection. */
export const UNREFLECTED_LAYER = 1;

const DOWN = new Vector3(0, -1, 0);
const _position = new Vector3();
const _forward = new Vector3();
const _up = new Vector3();
const _plane = new Plane();
const _clip = new Vector4();
const _q = new Vector4();
const _viewProjection = new Matrix4();
const _frustum = new Frustum();
const _size = new Vector2();

/**
 * Within this many metres of the water plane the oblique near plane passes through the eye and the
 * reflection's depth degenerates, so the pass is skipped while the camera crosses the waterline.
 */
export const WATERLINE_MARGIN = 0.005;

/**
 * Places `out` at `camera` mirrored in the level plane y = `level`, looking along the mirrored view.
 * Its image is the reflection flipped left to right (sample it at `screenUV.flipX()`), and its near
 * plane is the water plane itself (Lengyel's oblique clipping), so only what lies below is drawn.
 */
export function mirrorCamera(
  camera: PerspectiveCamera,
  level: number,
  out: PerspectiveCamera,
  coordinateSystem: CoordinateSystem,
): void {
  const e = camera.matrixWorld.elements;
  _position.setFromMatrixPosition(camera.matrixWorld);
  _forward.set(-e[8], e[9], -e[10]);
  _up.set(e[4], -e[5], e[6]);

  out.coordinateSystem = coordinateSystem;
  out.fov = camera.fov;
  out.aspect = camera.aspect;
  out.near = camera.near;
  out.far = camera.far;
  out.zoom = camera.zoom;
  out.position.set(_position.x, 2 * level - _position.y, _position.z);
  out.up.copy(_up);
  out.lookAt(_forward.add(out.position));
  out.updateMatrixWorld();

  const p = out.projectionMatrix.copy(camera.projectionMatrix).elements;
  _plane.setFromNormalAndCoplanarPoint(DOWN, _position.set(0, level, 0));
  _plane.applyMatrix4(out.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  _q.set(
    (Math.sign(_clip.x) + p[8]) / p[0],
    (Math.sign(_clip.y) + p[9]) / p[5],
    -1,
    (1 + p[10]) / p[14],
  );
  // The far corner Q must land on clip depth 1; WebGL's [-1, 1] range then needs twice the scale.
  const scale = coordinateSystem === WebGPUCoordinateSystem ? 1 : 2;
  _clip.multiplyScalar(scale / _clip.dot(_q));
  p[2] = _clip.x;
  p[6] = _clip.y;
  p[10] = coordinateSystem === WebGPUCoordinateSystem ? _clip.z : _clip.z + 1;
  p[14] = _clip.w;
  out.projectionMatrixInverse.copy(out.projectionMatrix).invert();
}

/**
 * The tank seen in the underside of the water surface: the scene drawn from the camera mirrored in
 * the surface, into a target the size of the drawing buffer times `resolutionScale`.
 */
export class SurfaceReflection {
  private readonly target = new RenderTarget(1, 1, { type: HalfFloatType });
  private readonly camera = new PerspectiveCamera();
  /**
   * Materials that pass the temporal resolve's velocity through carry a velocity-only MRT, which
   * writes no colour into a plain target: naming the colour output keeps theirs.
   */
  private readonly outputs = mrt({ output });
  private scale = 0;

  /** `surface` is the water surface as a flat box, for culling. */
  constructor(private readonly surface: Box3) {
    this.target.texture.name = 'output';
  }

  get enabled(): boolean {
    return this.scale > 0;
  }

  /** 0 turns the reflection off and frees its target. */
  setResolutionScale(scale: number): void {
    if (!(scale >= 0 && scale <= 1)) {
      throw new RangeError(
        `SurfaceReflection: resolution scale must be within [0, 1], got ${scale}`,
      );
    }
    if (scale === 0 && this.enabled) this.target.dispose();
    this.scale = scale;
  }

  /** The reflected radiance at the fragment's screen position moved by `offset` in UV. */
  sample(offset: Node<'vec2'>): Node<'vec4'> {
    return texture(this.target.texture, screenUV.flipX().add(offset));
  }

  /** Draws the reflection for `camera`, unless it is off or the camera cannot see the underside. */
  render(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    _position.setFromMatrixPosition(camera.matrixWorld);
    if (_position.y >= this.surface.max.y - WATERLINE_MARGIN) return;
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProjection, renderer.coordinateSystem);
    if (!_frustum.intersectsBox(this.surface)) return;

    renderer.getDrawingBufferSize(_size);
    this.target.setSize(
      Math.max(1, Math.round(_size.x * this.scale)),
      Math.max(1, Math.round(_size.y * this.scale)),
    );
    this.withMirror(renderer, camera, () => renderer.render(scene, this.camera));
  }

  /**
   * Builds the pass's pipelines for what `camera`'s mirror image sees, so the first frame under
   * the surface, or the first after a tier turns the reflection on, does not compile them.
   */
  async compile(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): Promise<void> {
    if (!this.enabled) return;
    await renderer.init();
    camera.updateMatrixWorld();
    // compileAsync reads the target and MRT before its first await, so they can be restored at once.
    await this.withMirror(renderer, camera, () => renderer.compileAsync(scene, this.camera));
  }

  private withMirror<T>(renderer: WebGPURenderer, camera: PerspectiveCamera, draw: () => T): T {
    mirrorCamera(camera, this.surface.max.y, this.camera, renderer.coordinateSystem);
    this.camera.layers.mask = camera.layers.mask;
    this.camera.layers.disable(UNREFLECTED_LAYER);

    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(this.target);
    renderer.setMRT(this.outputs);
    renderer.autoClear = true;
    try {
      return draw();
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setMRT(previousMrt);
      renderer.autoClear = autoClear;
    }
  }

  dispose(): void {
    this.target.dispose();
  }
}
