import type { TankDimensions } from '../engine/tank/dimensions';

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
  /** Orbit distance to start at; the standard tank's front view when omitted. */
  orbitDistance?: number;
  onModeChange?: (mode: CameraMode) => void;
}

export interface RoomVolume {
  min: Vec3;
  max: Vec3;
}

const ROOM_MARGIN = 0.1;
const ARC_ROOM_SAMPLES = 24;
const ARC_RESET_YAW = 0.3;
const RETARGET_SNAP = 1e-3;
const ROOM_SEARCH_STEPS = 64;
const ROOM_SAFE_PITCH = 0.1;

const DIVE_FLOOR_ABOVE_SUBSTRATE = 0.05;
const STANDARD_ORBIT_DISTANCE = 1.6;

export function tankBounds(d: TankDimensions): TankBounds {
  return {
    halfLength: d.length / 2,
    halfDepth: d.depth / 2,
    height: d.height,
    waterTop: d.height - d.freeboard,
    floor: d.substrateBack + DIVE_FLOOR_ABOVE_SUBSTRATE,
  };
}

export function orbitDistanceFor(scale: number): number {
  return STANDARD_ORBIT_DISTANCE * scale;
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
  private distance: number;
  private wantedDistance: number;

  private room: RoomVolume | null = null;

  private focusTarget: FocusTarget | null = null;
  private focusLast: Vec3 = { x: 0, y: 0.25, z: 0 };
  private focusDistance = FOCUS_DEFAULT_DISTANCE;

  private divePosition: Vec3 = { x: 0, y: 0.3, z: 0 };
  private diveYaw = Math.PI;
  private divePitch = 0;

  private eye: Vec3;
  private look: Vec3;
  private transitioning = false;
  private arcSign = 0;
  private arcYaw = 0;

  constructor(
    private readonly camera: CameraLike,
    private bounds: TankBounds,
    private readonly options: CameraOptions = {},
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.wantedDistance = options.orbitDistance ?? STANDARD_ORBIT_DISTANCE;
    this.distance = this.wantedDistance;
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

  /**
   * Re-fits the rig to another tank: the orbit circles its middle at `orbitDistance` (kept clear of
   * the new glass), and a dive or focus eye inside the water is pulled back within it.
   */
  setBounds(bounds: TankBounds, orbitDistance: number): void {
    this.bounds = bounds;
    this.orbitTarget = { x: 0, y: bounds.height / 2, z: 0 };
    this.wantedDistance = orbitDistance;
    this.clampOrbit();
    this.divePosition = this.clampDive(this.divePosition);
  }

  /** Keeps the outside eye within a room's walls, floor and ceiling; null lifts the limit. */
  setRoom(room: RoomVolume | null): void {
    this.room = room;
    this.clampOrbit();
  }

  get orbitDistance(): number {
    return this.distance;
  }

  get orbitAngles(): Readonly<{ yaw: number; pitch: number }> {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** Whether the outside eye has room at this heading, with no swing back toward the front. */
  canOrbitTo(yaw: number, pitch: number): boolean {
    const limits = this.orbitLimits(yaw, pitch);
    return limits.max >= limits.min;
  }

  setOrbit(yaw: number, pitch: number, distance: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
    this.wantedDistance = distance;
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
      this.wantedDistance = this.distance * factor;
      this.clampOrbit();
    }
  }

  update(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds)) return;
    const dt = clamp(dtSeconds, 0, MAX_DT);
    if (this.modeValue === 'focus') this.refreshFocus();
    let goal = this.goal();
    const rate = this.transitioning ? TRANSITION_RATE : FOLLOW_RATE;
    const alpha = this.reducedMotion ? 1 : 1 - Math.exp(-rate * dt);
    const from = this.eye;
    this.eye = this.chase(from, goal.eye, alpha);
    if (this.modeValue === 'orbit' && !this.insideGlass(from) && this.insideGlass(this.eye)) {
      this.eye = this.arcAroundGlass(from, goal.eye, alpha);
    }
    if (this.modeValue === 'orbit' && this.room && !this.roomAllows(this.eye)) {
      this.eye = this.retarget(from);
    }
    goal = this.goal();
    if (length(sub(this.eye, goal.eye)) < SETTLED_EPSILON) this.arcSign = 0;
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

  get goalPosition(): Readonly<Vec3> {
    return this.goal().eye;
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
      eye: this.keepInRoom(
        this.modeValue === 'focus' && this.insideGlass(target) ? this.clampDive(eye) : eye,
      ),
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

  /** A straight chase across the tank would pass through it; turn about the tank's middle instead. */
  private arcAroundGlass(from: Vec3, to: Vec3, alpha: number): Vec3 {
    const t = this.orbitTarget;
    const a0 = Math.atan2(from.x - t.x, from.z - t.z);
    const a1 = Math.atan2(to.x - t.x, to.z - t.z);
    const r0 = Math.hypot(from.x - t.x, from.z - t.z);
    const r1 = Math.hypot(to.x - t.x, to.z - t.z);
    const turn = Math.PI * 2;
    let delta = a1 - a0;
    delta -= turn * Math.round(delta / turn);
    const at = (fraction: number, d: number): Vec3 => {
      const angle = a0 + d * fraction;
      const radius = r0 + (r1 - r0) * fraction;
      return {
        x: t.x + Math.sin(angle) * radius,
        y: from.y + (to.y - from.y) * fraction,
        z: t.z + Math.cos(angle) * radius,
      };
    };
    if (this.room) {
      const [lo, hi] = this.roomLimits(this.room);
      const tol = 1e-9;
      const stays = (d: number): boolean => {
        for (let i = 1; i <= ARC_ROOM_SAMPLES; i++) {
          const p = at(i / ARC_ROOM_SAMPLES, d);
          if (
            p.x < lo.x - tol ||
            p.x > hi.x + tol ||
            p.y < lo.y - tol ||
            p.y > hi.y + tol ||
            p.z < lo.z - tol ||
            p.z > hi.z + tol ||
            !this.roomAllows(p)
          ) {
            return false;
          }
        }
        return true;
      };
      const other = (d: number): number => d - (d < 0 ? -turn : turn);
      if (this.arcSign !== 0 && Math.sign(delta) !== this.arcSign) delta = other(delta);
      if (!stays(delta)) {
        delta = other(delta);
        if (!stays(delta)) return this.retarget(from);
      }
    }
    this.arcSign = Math.sign(delta) || 1;
    this.arcYaw = this.yaw;
    const eye = at(alpha, delta);
    if (!this.insideGlass(eye)) return this.acceptStep(from, this.keepInRoom(eye));
    const offset = sub(eye, t);
    const span = length(offset);
    if (span < 1e-6) return this.retarget(from);
    const dir = { x: offset.x / span, y: offset.y / span, z: offset.z / span };
    const { min, max } = this.glassBox();
    const reach = distanceToBoxExit(t, dir, min, max) + GLASS_CLEARANCE;
    const pushed = this.keepInRoom({
      x: t.x + dir.x * reach,
      y: t.y + dir.y * reach,
      z: t.z + dir.z * reach,
    });
    return this.acceptStep(from, pushed);
  }

  private acceptStep(from: Vec3, step: Vec3): Vec3 {
    if (!this.room) return step;
    return this.insideGlass(step) || !this.roomAllows(step) ? this.retarget(from) : step;
  }

  private roomAllows(p: Vec3): boolean {
    const o = sub(p, this.orbitTarget);
    const span = length(o);
    if (span < 1e-9) return false;
    const { min, max } = this.orbitLimits(
      Math.atan2(o.x, o.z),
      Math.asin(clamp(o.y / span, -1, 1)),
    );
    return max >= min;
  }

  /**
   * The eye cannot make progress toward the goal: make the pose it is at the goal, so the state
   * stays consistent and any later drag or setOrbit moves it again. An eye that sits somewhere the
   * room leaves no space for is moved to the nearest orbit pose that has some.
   */
  private retarget(from: Vec3): Vec3 {
    const o = sub(from, this.orbitTarget);
    const span = length(o);
    this.distance = span;
    this.yaw = Math.atan2(o.x, o.z);
    this.pitch = clamp(Math.asin(clamp(o.y / Math.max(span, 1e-9), -1, 1)), PITCH_MIN, PITCH_MAX);
    this.clampOrbit();
    this.arcSign = 0;
    const goal = this.goal().eye;
    return length(sub(goal, from)) < RETARGET_SNAP ? from : goal;
  }

  /**
   * Keeps the orbit eye outside the glass and, when a room is set, inside it. A direction the room
   * leaves no space for (behind a tank that stands close to the back wall) swings round toward
   * the front view until there is.
   */
  private clampOrbit(): void {
    if (Math.abs(this.yaw - this.arcYaw) > ARC_RESET_YAW) this.arcSign = 0;
    if (this.room) this.swingIntoRoom();
    const { min, max } = this.orbitLimits(this.yaw, this.pitch);
    this.distance = clamp(this.wantedDistance, min, Math.max(min, max));
  }

  private orbitLimits(yaw: number, pitch: number): { min: number; max: number } {
    const dir = sphericalOffset(yaw, pitch, 1);
    const { min, max } = this.glassBox();
    const exit = distanceToBoxExit(this.orbitTarget, dir, min, max);
    const roomMax = this.room
      ? distanceToBoxExit(this.orbitTarget, dir, ...this.roomLimits(this.room))
      : ORBIT_MAX_DISTANCE;
    return {
      min: Math.max(ORBIT_MIN_DISTANCE, exit + GLASS_CLEARANCE),
      max: Math.min(ORBIT_MAX_DISTANCE, roomMax),
    };
  }

  private swingIntoRoom(): void {
    const fits = (yaw: number, pitch: number): boolean => {
      const l = this.orbitLimits(yaw, pitch);
      return l.max >= l.min;
    };
    if (fits(this.yaw, this.pitch)) return;
    const yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    for (let i = 1; i <= ROOM_SEARCH_STEPS; i++) {
      const y = yaw * (1 - i / ROOM_SEARCH_STEPS);
      if (fits(y, this.pitch)) {
        this.yaw = y;
        return;
      }
    }
    for (let i = 1; i <= ROOM_SEARCH_STEPS; i++) {
      const k = 1 - i / ROOM_SEARCH_STEPS;
      const y = yaw * k;
      const p = ROOM_SAFE_PITCH + (this.pitch - ROOM_SAFE_PITCH) * k;
      if (fits(y, p)) {
        this.yaw = y;
        this.pitch = p;
        return;
      }
    }
    this.yaw = 0;
    this.pitch = ROOM_SAFE_PITCH;
  }

  private roomLimits(room: RoomVolume): [Vec3, Vec3] {
    const m = ROOM_MARGIN;
    return [
      { x: room.min.x + m, y: room.min.y + m, z: room.min.z + m },
      { x: room.max.x - m, y: room.max.y - m, z: room.max.z - m },
    ];
  }

  private keepInRoom(eye: Vec3): Vec3 {
    if (!this.room) return eye;
    const [lo, hi] = this.roomLimits(this.room);
    return {
      x: clamp(eye.x, lo.x, hi.x),
      y: clamp(eye.y, lo.y, hi.y),
      z: clamp(eye.z, lo.z, hi.z),
    };
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
