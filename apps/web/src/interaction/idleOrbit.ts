import type { CameraMode } from './camera';

export const IDLE_AFTER_SECONDS = 45;
export const IDLE_YAW_RATE = 0.06;
const EASE_IN_SECONDS = 3;

export interface Orbitable {
  readonly mode: CameraMode;
  readonly orbitAngles: Readonly<{ yaw: number; pitch: number }>;
  canOrbitTo(yaw: number, pitch: number): boolean;
  rotateBy(yawRadians: number, pitchRadians: number): void;
}

const LOOKAHEAD_RADIANS = 0.08;

/**
 * The screensaver: after a while without input the outside camera drifts around the tank. It
 * turns the rig through `rotateBy`, so the rig's own glass and room limits still apply, and turns
 * back before a heading the room has no space for, so it sweeps between the allowed angles
 * without the rig having to pull it back. Reduced motion switches it off.
 */
export class IdleOrbit {
  private quiet = 0;
  private reducedMotion = false;
  private direction: 1 | -1 = 1;

  constructor(private readonly rig: Orbitable) {}

  get active(): boolean {
    return !this.reducedMotion && this.rig.mode === 'orbit' && this.quiet >= IDLE_AFTER_SECONDS;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.quiet = 0;
  }

  /** Any pointer, touch, wheel or key input: control returns at once. */
  input(): void {
    this.quiet = 0;
  }

  update(dtSeconds: number, paused = false): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    if (paused || this.reducedMotion || this.rig.mode !== 'orbit') {
      this.quiet = 0;
      return;
    }
    this.quiet += dtSeconds;
    if (this.quiet < IDLE_AFTER_SECONDS) return;
    const ease = Math.min(1, (this.quiet - IDLE_AFTER_SECONDS) / EASE_IN_SECONDS);
    const { yaw, pitch } = this.rig.orbitAngles;
    if (!this.rig.canOrbitTo(yaw + this.direction * LOOKAHEAD_RADIANS, pitch)) {
      this.direction = this.direction === 1 ? -1 : 1;
    }
    this.rig.rotateBy(-this.direction * IDLE_YAW_RATE * ease * dtSeconds, 0);
  }
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'] as const;

export function bindIdleInput(target: EventTarget, idle: IdleOrbit): () => void {
  const onInput = (): void => idle.input();
  for (const type of INPUT_EVENTS) target.addEventListener(type, onInput, { passive: true });
  return () => {
    for (const type of INPUT_EVENTS) target.removeEventListener(type, onInput);
  };
}
