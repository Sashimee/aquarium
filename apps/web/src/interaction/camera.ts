export type CameraMode = 'orbit' | 'focus' | 'dive';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraLike {
  position: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): void;
}

/** Metres; the tank is centred on x/z with its bottom glass at y = 0. */
export interface TankBounds {
  halfLength: number;
  halfDepth: number;
  height: number;
  /** Highest y the diving camera may reach (the water surface). */
  waterTop: number;
  /** Lowest y the diving camera may reach (above the substrate). */
  floor: number;
}

export interface CameraOptions {
  reducedMotion?: boolean;
  onModeChange?: (mode: CameraMode) => void;
}

export type FocusTarget = () => Vec3 | null;

const ORBIT_MIN_DISTANCE = 0.6;
const ORBIT_MAX_DISTANCE = 4;
const FOCUS_MIN_DISTANCE = 0.12;
const FOCUS_MAX_DISTANCE = 1.5;
const FOCUS_DEFAULT_DISTANCE = 0.45;
const GLASS_CLEARANCE = 0.12;
const DIVE_INSET = 0.05;
const DIVE_ENTRY_INSET = 0.08;
const DIVE_ZOOM_METRES = 0.5;
const PITCH_MIN = -0.15;
const PITCH_MAX = 1.35;
const DIVE_PITCH_LIMIT = 1.4;
const EYE_FLOOR = 0.04;
const RADIANS_PER_PIXEL = 0.005;
const REDUCED_MOTION_SENSITIVITY = 0.5;
const FOLLOW_RATE = 14;
const TRANSITION_RATE = 3.5;
const SETTLED_EPSILON = 0.01;
const MAX_DT = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Distance along `dir` (unit) from `origin`, which lies inside the box, to where the ray leaves it. */
export function distanceToBoxExit(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): number {
  let best = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    if (d === 0) continue;
    const t = d > 0 ? (max[axis] - origin[axis]) / d : (min[axis] - origin[axis]) / d;
    best = Math.min(best, Math.max(0, t));
  }
  return best;
}

function sphericalOffset(yaw: number, pitch: number, distance: number): Vec3 {
  const c = Math.cos(pitch);
  return {
    x: distance * Math.sin(yaw) * c,
    y: distance * Math.sin(pitch),
    z: distance * Math.cos(yaw) * c,
  };
}

function lookDirection(yaw: number, pitch: number): Vec3 {
  return sphericalOffset(yaw, pitch, 1);
}

/**
 * Camera state machine. Orbit circles the tank from outside the glass, focus follows a moving
 * point, dive puts the eye inside the water. The eye and look point chase their goals with
 * exponential smoothing; with reduced motion they cut straight to them and turn slower.
 */
export class CameraRig {
  private modeValue: CameraMode = 'orbit';
  private reducedMotion: boolean;

  private orbitTarget: Vec3 = { x: 0, y: 0.25, z: 0 };
  private yaw = 0;
  private pitch = 0.1;
  private distance = 1.6;

  private focusTarget: FocusTarget | null = null;
  private focusLast: Vec3 = { x: 0, y: 0.25, z: 0 };
  private focusDistance = FOCUS_DEFAULT_DISTANCE;

  private divePosition: Vec3 = { x: 0, y: 0.3, z: 0 };
  private diveYaw = Math.PI;
  private divePitch = 0;

  private eye: Vec3;
  private look: Vec3;
  private transitioning = false;

  constructor(
    private readonly camera: CameraLike,
    private readonly bounds: TankBounds,
    private readonly options: CameraOptions = {},
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.orbitTarget = { x: 0, y: bounds.height / 2, z: 0 };
    this.focusLast = { ...this.orbitTarget };
    const goal = this.goal();
    this.eye = goal.eye;
    this.look = goal.look;
    this.apply();
  }

  get mode(): CameraMode {
    return this.modeValue;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  setOrbit(yaw: number, pitch: number, distance: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
    this.distance = distance;
    this.clampOrbit();
  }

  focusOn(target: FocusTarget): void {
    const point = target();
    if (!point) return;
    this.focusTarget = target;
    this.focusLast = point;
    this.focusDistance = clamp(this.focusDistance, FOCUS_MIN_DISTANCE, FOCUS_MAX_DISTANCE);
    this.setMode('focus');
  }

  dive(): void {
    if (this.modeValue === 'dive') return;
    const offset = sub(this.eye, this.look);
    const span = length(offset);
    const out =
      span > 1e-6
        ? { x: offset.x / span, y: offset.y / span, z: offset.z / span }
        : { x: 0, y: 0, z: 1 };
    const { min, max } = this.glassBox();
    const entry = Math.max(0, distanceToBoxExit(this.look, out, min, max) - DIVE_ENTRY_INSET);
    this.divePosition = this.clampDive({
      x: this.look.x + out.x * entry,
      y: this.look.y + out.y * entry,
      z: this.look.z + out.z * entry,
    });
    this.diveYaw = Math.atan2(-out.x, -out.z);
    this.divePitch = clamp(-Math.asin(clamp(out.y, -1, 1)), -DIVE_PITCH_LIMIT, DIVE_PITCH_LIMIT);
    this.setMode('dive');
  }

  /** Back to the outside view (also leaves focus). */
  exit(): void {
    if (this.modeValue !== 'orbit') this.setMode('orbit');
  }

  rotateBy(yawRadians: number, pitchRadians: number): void {
    if (this.modeValue === 'dive') {
      this.diveYaw += yawRadians;
      this.divePitch = clamp(this.divePitch + pitchRadians, -DIVE_PITCH_LIMIT, DIVE_PITCH_LIMIT);
      return;
    }
    this.yaw -= yawRadians;
    this.pitch = clamp(this.pitch + pitchRadians, PITCH_MIN, PITCH_MAX);
    this.clampOrbit();
  }

  /** Drag in screen pixels. */
  drag(dx: number, dy: number): void {
    const k = RADIANS_PER_PIXEL * (this.reducedMotion ? REDUCED_MOTION_SENSITIVITY : 1);
    this.rotateBy(dx * k, dy * k);
  }

  /** `factor` above 1 moves away, below 1 moves closer. In dive mode it moves along the view. */
  zoom(factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    if (this.modeValue === 'dive') {
      const dir = lookDirection(this.diveYaw, this.divePitch);
      const step = (1 - factor) * DIVE_ZOOM_METRES;
      this.divePosition = this.clampDive({
        x: this.divePosition.x + dir.x * step,
        y: this.divePosition.y + dir.y * step,
        z: this.divePosition.z + dir.z * step,
      });
    } else if (this.modeValue === 'focus') {
      this.focusDistance = clamp(
        this.focusDistance * factor,
        FOCUS_MIN_DISTANCE,
        FOCUS_MAX_DISTANCE,
      );
    } else {
      this.distance *= factor;
      this.clampOrbit();
    }
  }

  update(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds)) return;
    const dt = clamp(dtSeconds, 0, MAX_DT);
    if (this.modeValue === 'focus') this.refreshFocus();
    const goal = this.goal();
    const rate = this.transitioning ? TRANSITION_RATE : FOLLOW_RATE;
    const alpha = this.reducedMotion ? 1 : 1 - Math.exp(-rate * dt);
    this.eye = this.chase(this.eye, goal.eye, alpha);
    this.look = this.chase(this.look, goal.look, alpha);
    if (
      this.transitioning &&
      length(sub(this.eye, goal.eye)) < SETTLED_EPSILON &&
      length(sub(this.look, goal.look)) < SETTLED_EPSILON
    ) {
      this.transitioning = false;
    }
    this.apply();
  }

  get position(): Readonly<Vec3> {
    return this.eye;
  }

  get lookAtPoint(): Readonly<Vec3> {
    return this.look;
  }

  private setMode(mode: CameraMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    this.transitioning = true;
    this.options.onModeChange?.(mode);
  }

  private refreshFocus(): void {
    const point = this.focusTarget?.() ?? null;
    if (point) {
      this.focusLast = point;
      return;
    }
    this.focusTarget = null;
    this.setMode('orbit');
  }

  private goal(): { eye: Vec3; look: Vec3 } {
    if (this.modeValue === 'dive') {
      const dir = lookDirection(this.diveYaw, this.divePitch);
      const p = this.divePosition;
      return { eye: p, look: { x: p.x + dir.x, y: p.y + dir.y, z: p.z + dir.z } };
    }
    const target = this.modeValue === 'focus' ? this.focusLast : this.orbitTarget;
    const distance = this.modeValue === 'focus' ? this.focusDistance : this.distance;
    const o = sphericalOffset(this.yaw, this.pitch, distance);
    const eye = { x: target.x + o.x, y: Math.max(EYE_FLOOR, target.y + o.y), z: target.z + o.z };
    return {
      eye: this.modeValue === 'focus' && this.insideGlass(target) ? this.clampDive(eye) : eye,
      look: target,
    };
  }

  private glassBox(): { min: Vec3; max: Vec3 } {
    const b = this.bounds;
    return {
      min: { x: -b.halfLength, y: 0, z: -b.halfDepth },
      max: { x: b.halfLength, y: b.height, z: b.halfDepth },
    };
  }

  private insideGlass(p: Vec3): boolean {
    const { min, max } = this.glassBox();
    return p.x > min.x && p.x < max.x && p.y > min.y && p.y < max.y && p.z > min.z && p.z < max.z;
  }

  /** Keeps the orbit eye outside the glass however the view is angled. */
  private clampOrbit(): void {
    const dir = sphericalOffset(this.yaw, this.pitch, 1);
    const { min, max } = this.glassBox();
    const exit = distanceToBoxExit(this.orbitTarget, dir, min, max);
    const minDistance = Math.max(ORBIT_MIN_DISTANCE, exit + GLASS_CLEARANCE);
    this.distance = clamp(this.distance, minDistance, Math.max(minDistance, ORBIT_MAX_DISTANCE));
  }

  private clampDive(p: Vec3): Vec3 {
    const b = this.bounds;
    return {
      x: clamp(p.x, -b.halfLength + DIVE_INSET, b.halfLength - DIVE_INSET),
      y: clamp(p.y, b.floor, b.waterTop - DIVE_INSET),
      z: clamp(p.z, -b.halfDepth + DIVE_INSET, b.halfDepth - DIVE_INSET),
    };
  }

  private chase(from: Vec3, to: Vec3, alpha: number): Vec3 {
    return {
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    };
  }

  private apply(): void {
    this.camera.position.set(this.eye.x, this.eye.y, this.eye.z);
    this.camera.lookAt(this.look.x, this.look.y, this.look.z);
  }
}
