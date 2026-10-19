import {
  Euler,
  InstancedMesh,
  type Material,
  Mesh,
  type Object3D,
  type PerspectiveCamera,
  Raycaster,
  type Scene,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { PhotoPost } from '../effectsSlot';
import type { EngineEventBus } from '../events';
import type { TankDimensions } from '../tank/dimensions';
import { clampEye, moveEye, type PhotoBounds, photoBounds, type Vec3 } from './bounds';
import { captureSize } from './capture';
import { isPhotoFilter, type PhotoFilter } from './grade';
import {
  clampFocusDistance,
  clampFStop,
  DEFAULT_F_STOP,
  DEFAULT_FOCUS_DISTANCE,
  viewDepth,
} from './lens';
import { PhotoLook } from './look';

export const FOV_RANGE = { min: 15, max: 75 } as const;
/** Short of straight up or down, where yaw stops meaning anything. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** TRAA starts over at a new resolution; this many frames settle its history for the capture. */
const TEMPORAL_CAPTURE_FRAMES = 12;

export interface PhotoDepthOfField {
  /** Asked for by the photographer. */
  readonly enabled: boolean;
  /** Whether the current tier draws it; on `low` it does not, and `enabled` waits for a better tier. */
  readonly available: boolean;
  /** Metres along the view axis. */
  readonly focusDistance: number;
  readonly fStop: number;
}

export interface PhotoState {
  readonly active: boolean;
  readonly filter: PhotoFilter;
  readonly depthOfField: PhotoDepthOfField;
  readonly simPaused: boolean;
  readonly uiHidden: boolean;
  /** Vertical field of view in degrees. */
  readonly fov: number;
}

/** Yaw 0 and pitch 0 look along -z, towards the tank from the default front view. */
export interface PhotoPose {
  readonly position: Readonly<Vec3>;
  /** Radians about +y; positive turns left. */
  readonly yaw: number;
  /** Radians; positive looks up. */
  readonly pitch: number;
}

export interface FocusHit {
  readonly point: Readonly<Vec3>;
  /** The new focus distance: the point's depth along the view axis. */
  readonly distance: number;
  readonly objectName: string;
}

export interface EnterOptions {
  /** The DOM overlay `setUiHidden` hides; without one, hiding is only announced. */
  readonly uiLayer?: HTMLElement | null;
}

export interface CaptureOptions {
  /** Output size as a multiple of the canvas's CSS size, in (0, 2]; device limits may lower it. */
  readonly scale?: number;
}

/** The engine parts photo mode drives; an interface so it can be tested without a GPU. */
export interface PhotoHost {
  readonly camera: PerspectiveCamera;
  readonly scene: Scene;
  readonly renderer: {
    readonly domElement: HTMLCanvasElement;
    getSize(target: Vector2): Vector2;
    getDrawingBufferSize(target: Vector2): Vector2;
    getPixelRatio(): number;
    setPixelRatio(value: number): void;
  };
  readonly events: EngineEventBus;
  /** The tank the free camera keeps outside of. */
  readonly tank: TankDimensions;
  /** Whether the current tier draws depth of field. */
  depthOfFieldTier(): boolean;
  /** Whether frames go through a temporal resolve. */
  temporal(): boolean;
  /** Largest texture side the device allows. */
  maxTextureSize(): number;
  setPost(post: PhotoPost | null): void;
  /** Resolves once the post pipeline `setPost` last asked for is drawing, or has failed. */
  ready(): Promise<void>;
  /** Draws one frame of the scene as it stands, through the same path as the render loop. */
  draw(): void;
  /** Called after the capture draws, which no frame-time sample should count. */
  captured(): void;
}

interface Entry {
  readonly position: Vector3;
  readonly quaternion: { x: number; y: number; z: number; w: number };
  readonly fov: number;
  readonly uiLayer: HTMLElement | null;
}

function opaque(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((m) => m.visible && !m.transparent && m.depthWrite);
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('capture: the canvas could not be encoded as PNG'));
      else resolve(blob);
    }, 'image/png');
  });
}

/**
 * Photo mode: a free camera held outside the glass, a lens with a focus distance and an
 * aperture, colour filters, a sim pause and PNG capture. The engine calls `apply` every frame;
 * everything else is for the UI.
 */
export class PhotoMode {
  readonly look = new PhotoLook();
  private entry: Entry | null = null;
  private bounds: PhotoBounds | null = null;
  private readonly boundsLens = { near: 0, fov: 0, aspect: 0 };
  private readonly eye = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private fov = 40;
  private filter: PhotoFilter = 'natural';
  private dofEnabled = false;
  private focusDistance = DEFAULT_FOCUS_DISTANCE;
  private fStop = DEFAULT_F_STOP;
  private paused = false;
  private uiHidden = false;
  private uiStyle: { visibility: string; inert: boolean } | null = null;
  private capturing = false;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly size = new Vector2();
  private readonly forward = new Vector3();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly stopTierWatch: () => void;

  constructor(private readonly host: PhotoHost) {
    this.stopTierWatch = host.events.on('quality:tier-changed', () => {
      if (this.entry !== null) this.announce();
    });
  }

  get active(): boolean {
    return this.entry !== null;
  }

  /** Whether the fish sim should hold still; the fish system reads it every frame. */
  get simPaused(): boolean {
    return this.paused;
  }

  get state(): PhotoState {
    return {
      active: this.entry !== null,
      filter: this.filter,
      depthOfField: {
        enabled: this.dofEnabled,
        available: this.host.depthOfFieldTier(),
        focusDistance: this.focusDistance,
        fStop: this.fStop,
      },
      simPaused: this.paused,
      uiHidden: this.uiHidden,
      fov: this.fov,
    };
  }

  get pose(): PhotoPose {
    const { x, y, z } = this.eye;
    return { position: { x, y, z }, yaw: this.yaw, pitch: this.pitch };
  }

  /** Where the scene is seen from: the photo eye in photo mode, else the camera. */
  get viewPosition(): Vector3 {
    return this.entry === null ? this.host.camera.position : this.eye;
  }

  /** Takes over the camera from where it is now. A second call while active does nothing. */
  enter(options: EnterOptions = {}): void {
    if (this.entry !== null) return;
    const { camera } = this.host;
    camera.updateMatrixWorld();
    this.entry = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      fov: camera.fov,
      uiLayer: options.uiLayer ?? null,
    };
    camera.getWorldDirection(this.forward);
    this.yaw = Math.atan2(-this.forward.x, -this.forward.z);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(this.forward.y)));
    this.fov = camera.fov;
    this.eye.copy(clampEye(camera.position, this.currentBounds()));
    this.pushPost();
    this.apply();
    this.announce();
  }

  /** Hands the camera back as it was, and lifts the pause and the hidden UI. */
  exit(): void {
    const entry = this.entry;
    if (entry === null) return;
    this.showUi();
    this.entry = null;
    this.paused = false;
    this.host.setPost(null);
    const { camera } = this.host;
    camera.position.copy(entry.position);
    camera.quaternion.set(
      entry.quaternion.x,
      entry.quaternion.y,
      entry.quaternion.z,
      entry.quaternion.w,
    );
    camera.fov = entry.fov;
    camera.updateProjectionMatrix();
    this.announce();
  }

  /** Turns the view by `dYaw` and `dPitch` radians. */
  turn(dYaw: number, dPitch: number): void {
    this.requireActive('turn');
    if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) {
      throw new RangeError(`photo turn: angles must be finite, got ${dYaw}, ${dPitch}`);
    }
    this.yaw = (this.yaw + dYaw) % (2 * Math.PI);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
  }

  /**
   * Moves the eye by metres: `right` and `forward` along the view (forward follows the pitch, as
   * a drone flies), `up` along world up. The eye slides along the glass rather than crossing it.
   */
  move(right: number, up: number, forward: number): void {
    this.requireActive('move');
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const to = {
      x: this.eye.x + right * cy - forward * sy * cp,
      y: this.eye.y + up + forward * sp,
      z: this.eye.z - right * sy - forward * cy * cp,
    };
    this.eye.copy(moveEye(this.eye, to, this.currentBounds()));
  }

  /** Puts the eye at `pose`, or the nearest place to it outside the tank. */
  setPose(pose: PhotoPose): void {
    this.requireActive('setPose');
    if (!Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) {
      throw new RangeError(`photo pose: angles must be finite, got ${pose.yaw}, ${pose.pitch}`);
    }
    this.eye.copy(clampEye(pose.position, this.currentBounds()));
    this.yaw = pose.yaw % (2 * Math.PI);
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pose.pitch));
  }

  /** Vertical field of view in degrees, clamped to `FOV_RANGE`. */
  setFov(degrees: number): void {
    this.requireActive('setFov');
    if (!Number.isFinite(degrees)) throw new RangeError(`photo fov must be finite, got ${degrees}`);
    this.fov = Math.max(FOV_RANGE.min, Math.min(FOV_RANGE.max, degrees));
    this.announce();
  }

  setFilter(filter: PhotoFilter): void {
    if (!isPhotoFilter(filter))
      throw new RangeError(`photo filter: unknown filter ${String(filter)}`);
    const graded = this.graded;
    this.filter = filter;
    this.look.setFilter(filter);
    if (this.entry !== null && this.graded !== graded) this.pushPost();
    this.announce();
  }

  /** Any subset of the lens; distances and f-stops are clamped to their ranges. */
  setDepthOfField(lens: { enabled?: boolean; focusDistance?: number; fStop?: number }): void {
    if (lens.focusDistance !== undefined)
      this.focusDistance = clampFocusDistance(lens.focusDistance);
    if (lens.fStop !== undefined) this.fStop = clampFStop(lens.fStop);
    if (lens.enabled !== undefined && lens.enabled !== this.dofEnabled) {
      this.dofEnabled = lens.enabled;
      if (this.entry !== null) this.pushPost();
    }
    this.announce();
  }

  /**
   * Focuses on what is under canvas point (`x`, `y`) in CSS pixels: the nearest opaque surface,
   * fish included. Returns null, keeping the focus, when the ray meets nothing but the room.
   */
  focusAt(x: number, y: number): FocusHit | null {
    this.requireActive('focusAt');
    const hit = this.pick(x, y);
    if (hit === null) return null;
    this.focusDistance = clampFocusDistance(hit.distance);
    this.announce();
    return { ...hit, distance: this.focusDistance };
  }

  /** Freezes the fish where they are; the rest of the tank keeps moving. */
  setSimPaused(paused: boolean): void {
    this.requireActive('setSimPaused');
    this.paused = paused;
    this.announce();
  }

  setUiHidden(hidden: boolean): void {
    this.requireActive('setUiHidden');
    if (hidden) this.hideUi();
    else this.showUi();
    this.announce();
  }

  /**
   * The current view as a PNG, at `scale` times the canvas's CSS size. The frame is drawn at
   * that size through the live tier's pipeline, so it matches the preview, only sharper. It waits
   * for the pipeline the look asks for, and rejects outside photo mode, if photo mode ends while
   * it waits, or while another capture is running.
   */
  async capture(options: CaptureOptions = {}): Promise<Blob> {
    this.requireActive('capture');
    if (this.capturing) throw new Error('capture: a capture is already running');
    this.capturing = true;
    try {
      await this.host.ready();
      if (this.entry === null) throw new Error('capture: photo mode ended before the capture');
      return await this.drawCapture(options.scale ?? 2);
    } finally {
      this.capturing = false;
    }
  }

  /** Puts the photo camera and lens in place for the next draw; the engine calls it every frame. */
  apply(): void {
    if (this.entry === null) return;
    const { camera, renderer } = this.host;
    const bounds = this.bounds;
    if (this.currentBounds() !== bounds) this.eye.copy(clampEye(this.eye, this.currentBounds()));
    camera.position.copy(this.eye);
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    renderer.getDrawingBufferSize(this.size);
    this.look.setLens(this.focusDistance, this.fStop, Math.max(1, this.size.y));
  }

  dispose(): void {
    this.exit();
    this.stopTierWatch();
  }

  private get graded(): boolean {
    return this.filter !== 'natural';
  }

  private drawCapture(scale: number): Promise<Blob> {
    const { renderer } = this.host;
    renderer.getSize(this.size);
    const size = captureSize(this.size.x, this.size.y, scale, this.host.maxTextureSize());
    const before = renderer.getPixelRatio();
    try {
      renderer.setPixelRatio(size.pixelRatio);
      this.apply();
      const frames = this.host.temporal() ? TEMPORAL_CAPTURE_FRAMES : 1;
      for (let i = 0; i < frames; i++) this.host.draw();
      // The canvas is copied when toBlob is called, before the pixel ratio goes back.
      return canvasBlob(renderer.domElement);
    } finally {
      renderer.setPixelRatio(before);
      this.apply();
      this.host.captured();
    }
  }

  /** The bounds for the photo lens as it is now; a wider view or frame keeps the eye farther off. */
  private currentBounds(): PhotoBounds {
    const { camera, tank } = this.host;
    const lens = this.boundsLens;
    if (
      this.bounds === null ||
      lens.near !== camera.near ||
      lens.fov !== this.fov ||
      lens.aspect !== camera.aspect
    ) {
      lens.near = camera.near;
      lens.fov = this.fov;
      lens.aspect = camera.aspect;
      this.bounds = photoBounds(tank, lens);
    }
    return this.bounds;
  }

  private requireActive(call: string): void {
    if (this.entry === null)
      throw new Error(`photo mode: ${call}() outside photo mode; enter() first`);
  }

  private pushPost(): void {
    this.host.setPost({ look: this.look, depthOfField: this.dofEnabled, graded: this.graded });
  }

  private announce(): void {
    this.host.events.emit('photo:changed', this.state);
  }

  private hideUi(): void {
    this.uiHidden = true;
    const layer = this.entry?.uiLayer ?? null;
    if (layer === null || this.uiStyle !== null) return;
    this.uiStyle = { visibility: layer.style.visibility, inert: layer.inert };
    layer.style.visibility = 'hidden';
    layer.inert = true;
  }

  private showUi(): void {
    this.uiHidden = false;
    const layer = this.entry?.uiLayer ?? null;
    const saved = this.uiStyle;
    this.uiStyle = null;
    if (layer === null || saved === null) return;
    layer.style.visibility = saved.visibility;
    layer.inert = saved.inert;
  }

  private pick(x: number, y: number): FocusHit | null {
    const { camera, scene, renderer } = this.host;
    const canvas = renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!(w > 0 && h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    this.apply();
    this.ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    this.raycaster.layers.mask = camera.layers.mask;
    this.raycaster.near = camera.near;
    this.raycaster.far = camera.far;
    const candidates: Object3D[] = [];
    scene.traverseVisible((object) => {
      if (!(object instanceof Mesh) || !opaque(object.material)) return;
      // Instanced fish and plants move every frame; their cached bounds are from whenever first asked.
      if (object instanceof InstancedMesh) object.computeBoundingSphere();
      candidates.push(object);
    });
    const [first] = this.raycaster.intersectObjects(candidates, false);
    if (first === undefined) return null;
    camera.getWorldDirection(this.forward);
    const { x: px, y: py, z: pz } = first.point;
    return {
      point: { x: px, y: py, z: pz },
      distance: viewDepth(first.point, camera.position, this.forward),
      objectName: first.object.name,
    };
  }
}
