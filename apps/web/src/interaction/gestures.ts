export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** Milliseconds, any monotonic origin. */
  time: number;
  kind: PointerKind;
  button: number;
}

export interface TapEvent {
  x: number;
  y: number;
  kind: PointerKind;
  button: number;
}

export interface DragEvent {
  x: number;
  y: number;
  dx: number;
  dy: number;
  kind: PointerKind;
  button: number;
  afterLongPress: boolean;
}

export interface PinchEvent {
  x: number;
  y: number;
  /** Ratio of the current finger distance to the previous one: above 1 spreads, below 1 pinches. */
  scale: number;
  dx: number;
  dy: number;
}

export interface GestureHandlers {
  tap?(event: TapEvent): void;
  longPress?(event: TapEvent): void;
  dragStart?(event: DragEvent): void;
  drag?(event: DragEvent): void;
  dragEnd?(event: DragEvent): void;
  pinch?(event: PinchEvent): void;
}

export interface GestureTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GestureConfig {
  longPressMs: number;
  tapMaxMs: number;
  /** Movement in CSS pixels before a press becomes a drag. Fingers wobble more than mice. */
  slop: Record<PointerKind, number>;
  timers: GestureTimers;
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  longPressMs: 500,
  tapMaxMs: 350,
  slop: { mouse: 4, touch: 10, pen: 6 },
  timers: {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

interface Tracked extends PointerSample {
  startX: number;
  startY: number;
  startTime: number;
}

/**
 * Turns raw pointer samples into tap, long-press, drag and pinch. It knows nothing about the DOM,
 * so mouse, pen and touch take exactly the same path.
 */
export class GestureRecognizer {
  private readonly config: GestureConfig;
  private readonly pointers = new Map<number, Tracked>();
  private dragging = false;
  private longPressed = false;
  /** Set once two fingers were down; the remaining finger must not turn into a tap or drag. */
  private multiTouch = false;
  private longPressTimer: unknown = null;
  private lastPinch: { distance: number; x: number; y: number } | null = null;

  constructor(
    private readonly handlers: GestureHandlers,
    config: Partial<GestureConfig> = {},
  ) {
    this.config = { ...DEFAULT_GESTURE_CONFIG, ...config };
  }

  pointerDown(sample: PointerSample): void {
    if (this.pointers.has(sample.id)) return;
    this.pointers.set(sample.id, {
      ...sample,
      startX: sample.x,
      startY: sample.y,
      startTime: sample.time,
    });
    if (this.pointers.size === 1) {
      this.multiTouch = false;
      this.longPressed = false;
      this.armLongPress(sample);
      return;
    }
    this.cancelLongPress();
    if (this.pointers.size === 2) {
      this.endDrag();
      this.multiTouch = true;
      this.lastPinch = this.measurePinch();
    }
  }

  pointerMove(sample: PointerSample): void {
    const tracked = this.pointers.get(sample.id);
    if (!tracked) return;
    const dx = sample.x - tracked.x;
    const dy = sample.y - tracked.y;
    tracked.x = sample.x;
    tracked.y = sample.y;
    tracked.time = sample.time;

    if (this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (this.multiTouch) return;

    if (!this.dragging) {
      const moved = Math.hypot(sample.x - tracked.startX, sample.y - tracked.startY);
      if (moved <= this.config.slop[tracked.kind]) return;
      this.cancelLongPress();
      this.dragging = true;
      this.handlers.dragStart?.(this.dragEvent(tracked, 0, 0));
    }
    this.handlers.drag?.(this.dragEvent(tracked, dx, dy));
  }

  pointerUp(sample: PointerSample): void {
    const tracked = this.pointers.get(sample.id);
    if (!tracked) return;
    tracked.x = sample.x;
    tracked.y = sample.y;
    const wasSingle = this.pointers.size === 1 && !this.multiTouch;
    this.pointers.delete(sample.id);
    this.cancelLongPress();

    if (this.dragging) {
      this.endDrag(tracked);
    } else if (wasSingle && !this.longPressed) {
      const slop = this.config.slop[tracked.kind];
      const moved = Math.hypot(sample.x - tracked.startX, sample.y - tracked.startY);
      if (moved <= slop && sample.time - tracked.startTime <= this.config.tapMaxMs) {
        this.handlers.tap?.(this.tapEvent(tracked));
      }
    }
    if (this.pointers.size < 2) this.lastPinch = null;
    if (this.pointers.size === 0) this.reset();
  }

  pointerCancel(id: number): void {
    const tracked = this.pointers.get(id);
    if (!tracked) return;
    this.pointers.delete(id);
    this.cancelLongPress();
    this.endDrag(tracked);
    if (this.pointers.size < 2) this.lastPinch = null;
    if (this.pointers.size === 0) this.reset();
  }

  /** Drops every active pointer without emitting a tap, e.g. when the window loses focus. */
  cancelAll(): void {
    for (const id of [...this.pointers.keys()]) this.pointerCancel(id);
  }

  get activePointers(): number {
    return this.pointers.size;
  }

  private armLongPress(sample: PointerSample): void {
    this.longPressTimer = this.config.timers.setTimeout(() => {
      this.longPressTimer = null;
      const tracked = this.pointers.get(sample.id);
      if (!tracked || this.dragging || this.multiTouch) return;
      this.longPressed = true;
      this.handlers.longPress?.(this.tapEvent(tracked));
    }, this.config.longPressMs);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer === null) return;
    this.config.timers.clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  private endDrag(last?: Tracked): void {
    if (!this.dragging) return;
    this.dragging = false;
    const source = last ?? [...this.pointers.values()][0];
    if (source) this.handlers.dragEnd?.(this.dragEvent(source, 0, 0));
  }

  private reset(): void {
    this.dragging = false;
    this.longPressed = false;
    this.multiTouch = false;
    this.lastPinch = null;
  }

  private measurePinch(): { distance: number; x: number; y: number } | null {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }

  private updatePinch(): void {
    const now = this.measurePinch();
    const before = this.lastPinch;
    this.lastPinch = now;
    if (!now || !before || before.distance === 0 || now.distance === 0) return;
    this.handlers.pinch?.({
      x: now.x,
      y: now.y,
      scale: now.distance / before.distance,
      dx: now.x - before.x,
      dy: now.y - before.y,
    });
  }

  private tapEvent(p: Tracked): TapEvent {
    return { x: p.x, y: p.y, kind: p.kind, button: p.button };
  }

  private dragEvent(p: Tracked, dx: number, dy: number): DragEvent {
    return {
      x: p.x,
      y: p.y,
      dx,
      dy,
      kind: p.kind,
      button: p.button,
      afterLongPress: this.longPressed,
    };
  }
}
