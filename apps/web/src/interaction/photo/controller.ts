import type { EngineEvents, EventBus } from '../../engine/events';
import type { PhotoFilter } from '../../engine/photo/grade';
import type { EnterOptions, FocusHit, PhotoState } from '../../engine/photo/PhotoMode';
import type { InteractionEvents, PhotoCaptureFailure, PhotoCommand, PhotoMove } from '../events';

/** The part of `PhotoMode` the controller drives; an interface so it can be tested without a GPU. */
export interface PhotoPort {
  readonly active: boolean;
  readonly state: PhotoState;
  enter(options?: EnterOptions): void;
  exit(): void;
  turn(dYaw: number, dPitch: number): void;
  move(right: number, up: number, forward: number): void;
  setFov(degrees: number): void;
  setFilter(filter: PhotoFilter): void;
  setDepthOfField(lens: { enabled?: boolean; focusDistance?: number; fStop?: number }): void;
  focusAt(x: number, y: number): FocusHit | null;
  setSimPaused(paused: boolean): void;
  setUiHidden(hidden: boolean): void;
  capture(): Promise<Blob>;
}

export interface PhotoControllerOptions {
  port: PhotoPort;
  interaction: EventBus<InteractionEvents>;
  engineEvents: EventBus<EngineEvents>;
  /** The overlay to hide while framing; looked up when photo mode starts. */
  uiLayer(): HTMLElement | null;
  /** Height of the canvas in CSS pixels, so a drag turns the view by what it covers. */
  viewHeight(): number;
  /** Keys belong to an open dialog, not the camera. */
  dialogOpen(): boolean;
}

export type HeldAction =
  | PhotoMove
  | 'turn-left'
  | 'turn-right'
  | 'turn-up'
  | 'turn-down'
  | 'zoom-in'
  | 'zoom-out'
  | 'fast';

export const MOVE_SPEED = 0.5;
export const FAST_FACTOR = 3;
export const TURN_SPEED = 1;
export const ZOOM_SPEED = 40;
const REFERENCE_FOV = 40;
const MAX_STEP_S = 0.1;

const KEYS: Readonly<Record<string, HeldAction>> = {
  w: 'forward',
  s: 'back',
  a: 'left',
  d: 'right',
  q: 'down',
  e: 'up',
  ArrowLeft: 'turn-left',
  ArrowRight: 'turn-right',
  ArrowUp: 'turn-up',
  ArrowDown: 'turn-down',
  '+': 'zoom-in',
  '=': 'zoom-in',
  '-': 'zoom-out',
  _: 'zoom-out',
  Shift: 'fast',
};

export function actionForKey(key: string): HeldAction | null {
  return KEYS[key] ?? KEYS[key.toLowerCase()] ?? null;
}

interface CaptureFailure {
  reason: PhotoCaptureFailure;
  message: string;
}

const CONCURRENT: CaptureFailure = {
  reason: 'concurrent',
  message: 'A picture is already being taken. Wait for it to finish.',
};

/**
 * Maps the capture errors the engine throws to something a player can act on. The engine reports
 * them as plain errors, so the timeout and concurrent cases are told apart by their message.
 */
export function describeCaptureError(error: unknown, stillActive: boolean): CaptureFailure {
  const text = error instanceof Error ? error.message : String(error);
  if (!stillActive) {
    return {
      reason: 'exited',
      message: 'Photo mode closed before the picture was taken. Nothing was saved.',
    };
  }
  if (text.includes('not ready after')) {
    return {
      reason: 'timeout',
      message: 'The picture effects took too long to get ready. Wait a moment and try again.',
    };
  }
  if (text.includes('already running')) return CONCURRENT;
  return { reason: 'failed', message: `The picture could not be taken. ${text}` };
}

const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isFormField(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: unknown } | null)?.tagName;
  return typeof tag === 'string' && FORM_TAGS.has(tag);
}

export class PhotoController {
  private readonly held = new Set<HeldAction>();
  private capturing = false;
  private readonly stops: (() => void)[];

  constructor(private readonly options: PhotoControllerOptions) {
    this.stops = [
      options.interaction.on('photo:request', (command) => this.handle(command)),
      options.engineEvents.on('photo:changed', () => this.publish()),
    ];
  }

  get active(): boolean {
    return this.options.port.active;
  }

  dispose(): void {
    this.stops.forEach((stop) => stop());
    this.held.clear();
    if (this.options.port.active) this.options.port.exit();
  }

  handle(command: PhotoCommand): void {
    const { port } = this.options;
    switch (command.type) {
      case 'enter':
        port.enter({ uiLayer: this.options.uiLayer() });
        return;
      case 'exit':
        this.held.clear();
        port.exit();
        return;
      case 'filter':
        if (port.active) port.setFilter(command.filter);
        return;
      case 'dof':
        if (port.active) {
          port.setDepthOfField({
            ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
            ...(command.focusDistance === undefined
              ? {}
              : { focusDistance: command.focusDistance }),
            ...(command.fStop === undefined ? {} : { fStop: command.fStop }),
          });
        }
        return;
      case 'fov':
        if (port.active) port.setFov(command.degrees);
        return;
      case 'freeze':
        if (port.active) port.setSimPaused(command.paused);
        return;
      case 'hide-ui':
        if (port.active) port.setUiHidden(command.hidden);
        return;
      case 'hold':
        if (command.down) this.held.add(command.move);
        else this.held.delete(command.move);
        return;
      case 'capture':
        void this.capture();
        return;
    }
  }

  /** Applies the keys and pad buttons that are held, for the time since the last frame. */
  update(deltaS: number): void {
    const { port } = this.options;
    if (!port.active || this.held.size === 0) return;
    const dt = Math.min(Math.max(deltaS, 0), MAX_STEP_S);
    const axis = (plus: HeldAction, minus: HeldAction) =>
      (this.held.has(plus) ? 1 : 0) - (this.held.has(minus) ? 1 : 0);
    const { fov } = port.state;

    const speed = MOVE_SPEED * dt * (this.held.has('fast') ? FAST_FACTOR : 1);
    const right = axis('right', 'left');
    const up = axis('up', 'down');
    const forward = axis('forward', 'back');
    if (right !== 0 || up !== 0 || forward !== 0) {
      port.move(right * speed, up * speed, forward * speed);
    }

    const turn = TURN_SPEED * dt * (fov / REFERENCE_FOV);
    const yaw = axis('turn-left', 'turn-right');
    const pitch = axis('turn-up', 'turn-down');
    if (yaw !== 0 || pitch !== 0) port.turn(yaw * turn, pitch * turn);

    const zoom = axis('zoom-out', 'zoom-in');
    if (zoom !== 0) port.setFov(fov + zoom * ZOOM_SPEED * dt);
  }

  /** A one-finger or mouse drag: the picture follows the finger. */
  drag(dx: number, dy: number): void {
    const { port } = this.options;
    if (!port.active) return;
    const height = this.options.viewHeight();
    if (!(height > 0)) return;
    const perPixel = (port.state.fov * Math.PI) / 180 / height;
    port.turn(dx * perPixel, dy * perPixel);
  }

  /** `factor` above 1 widens the view, below 1 narrows it. */
  zoom(factor: number): void {
    const { port } = this.options;
    if (port.active && Number.isFinite(factor) && factor > 0) port.setFov(port.state.fov * factor);
  }

  /** A tap focuses on what is under it, when depth of field is on. */
  tap(x: number, y: number): void {
    const { port } = this.options;
    if (port.active && port.state.depthOfField.enabled) port.focusAt(x, y);
  }

  /** Returns true when the key was a photo key, so the caller can stop it scrolling the page. */
  keyDown(
    event: Pick<KeyboardEvent, 'key' | 'target' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  ): boolean {
    const { port } = this.options;
    if (!port.active || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (isFormField(event.target) || this.options.dialogOpen()) return false;
    if (event.key === 'Escape') {
      this.handle({ type: 'exit' });
      return true;
    }
    if (event.key === 'h' || event.key === 'H') {
      port.setUiHidden(!port.state.uiHidden);
      return true;
    }
    const action = actionForKey(event.key);
    if (action === null) return false;
    this.held.add(action);
    return true;
  }

  keyUp(key: string): void {
    const action = actionForKey(key);
    if (action !== null) this.held.delete(action);
  }

  releaseAll(): void {
    this.held.clear();
  }

  private async capture(): Promise<void> {
    const { port, interaction } = this.options;
    if (this.capturing) {
      interaction.emit('photo:capture', { status: 'failed', ...CONCURRENT });
      return;
    }
    this.capturing = true;
    this.publish();
    try {
      const blob = await port.capture();
      interaction.emit('photo:capture', { status: 'done', blob });
    } catch (error) {
      interaction.emit('photo:capture', {
        status: 'failed',
        ...describeCaptureError(error, port.active),
      });
    } finally {
      this.capturing = false;
      this.publish();
    }
  }

  private publish(): void {
    this.options.interaction.emit('photo:view', {
      state: this.options.port.state,
      capturing: this.capturing,
    });
  }
}
