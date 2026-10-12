import { describe, expect, it, vi } from 'vitest';
import {
  GestureRecognizer,
  type GestureHandlers,
  type GestureTimers,
  type PointerKind,
  type PointerSample,
} from './gestures';

class FakeTimers implements GestureTimers {
  private next = 1;
  private readonly pending = new Map<number, { at: number; cb: () => void }>();
  now = 0;

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.cb();
      }
    }
  }

  get count(): number {
    return this.pending.size;
  }
}

function setup(handlers: GestureHandlers = {}) {
  const timers = new FakeTimers();
  const spies = {
    tap: vi.fn(),
    longPress: vi.fn(),
    dragStart: vi.fn(),
    drag: vi.fn(),
    dragEnd: vi.fn(),
    pinch: vi.fn(),
  };
  const recognizer = new GestureRecognizer({ ...spies, ...handlers }, { timers });
  const p = (
    id: number,
    x: number,
    y: number,
    kind: PointerKind = 'mouse',
    button = 0,
  ): PointerSample => ({ id, x, y, time: timers.now, kind, button });
  return { recognizer, timers, spies, p };
}

describe('GestureRecognizer', () => {
  it('reports a quick press and release as a tap', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 10, 20));
    timers.advance(100);
    recognizer.pointerUp(p(1, 10, 20));
    expect(spies.tap).toHaveBeenCalledWith({ x: 10, y: 20, kind: 'mouse', button: 0 });
    expect(spies.longPress).not.toHaveBeenCalled();
    expect(timers.count).toBe(0);
  });

  it('treats a touch wobble inside the touch slop as a tap but not a mouse drag of the same size', () => {
    const touch = setup();
    touch.recognizer.pointerDown(touch.p(1, 0, 0, 'touch'));
    touch.recognizer.pointerMove(touch.p(1, 8, 0, 'touch'));
    touch.recognizer.pointerUp(touch.p(1, 8, 0, 'touch'));
    expect(touch.spies.tap).toHaveBeenCalledTimes(1);
    expect(touch.spies.dragStart).not.toHaveBeenCalled();

    const mouse = setup();
    mouse.recognizer.pointerDown(mouse.p(1, 0, 0));
    mouse.recognizer.pointerMove(mouse.p(1, 8, 0));
    mouse.recognizer.pointerUp(mouse.p(1, 8, 0));
    expect(mouse.spies.dragStart).toHaveBeenCalledTimes(1);
    expect(mouse.spies.tap).not.toHaveBeenCalled();
  });

  it('does not tap when the press is held too long', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0));
    timers.advance(400);
    recognizer.pointerUp(p(1, 0, 0));
    expect(spies.tap).not.toHaveBeenCalled();
  });

  it('fires one long-press after the delay and suppresses the tap on release', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 5, 5, 'touch'));
    timers.advance(499);
    expect(spies.longPress).not.toHaveBeenCalled();
    timers.advance(1);
    expect(spies.longPress).toHaveBeenCalledTimes(1);
    recognizer.pointerUp(p(1, 5, 5, 'touch'));
    expect(spies.tap).not.toHaveBeenCalled();
  });

  it('cancels the long-press when the pointer drags away', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0));
    recognizer.pointerMove(p(1, 30, 0));
    timers.advance(1000);
    expect(spies.longPress).not.toHaveBeenCalled();
  });

  it('emits dragStart then incremental drags then dragEnd', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0));
    recognizer.pointerMove(p(1, 2, 0));
    expect(spies.dragStart).not.toHaveBeenCalled();
    recognizer.pointerMove(p(1, 10, 0));
    expect(spies.dragStart).toHaveBeenCalledTimes(1);
    expect(spies.drag).toHaveBeenLastCalledWith(expect.objectContaining({ dx: 8, dy: 0 }));
    recognizer.pointerMove(p(1, 15, 4));
    expect(spies.drag).toHaveBeenLastCalledWith(expect.objectContaining({ dx: 5, dy: 4 }));
    recognizer.pointerUp(p(1, 15, 4));
    expect(spies.dragEnd).toHaveBeenCalledTimes(1);
    expect(spies.tap).not.toHaveBeenCalled();
  });

  it('keeps the button of the pointer that started the drag', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0, 'mouse', 2));
    recognizer.pointerMove(p(1, 20, 0, 'mouse', 2));
    expect(spies.drag).toHaveBeenCalledWith(expect.objectContaining({ button: 2 }));
  });

  it('flags a drag that follows a long-press', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0, 'touch'));
    timers.advance(600);
    recognizer.pointerMove(p(1, 40, 0, 'touch'));
    expect(spies.drag).toHaveBeenCalledWith(expect.objectContaining({ afterLongPress: true }));
  });

  it('pinch reports the scale between successive moves around the midpoint', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0, 'touch'));
    recognizer.pointerDown(p(2, 100, 0, 'touch'));
    recognizer.pointerMove(p(2, 150, 0, 'touch'));
    expect(spies.pinch).toHaveBeenCalledTimes(1);
    const event = spies.pinch.mock.calls[0]?.[0] as { scale: number; x: number };
    expect(event.scale).toBeCloseTo(1.5);
    expect(event.x).toBeCloseTo(75);
    recognizer.pointerMove(p(1, 50, 0, 'touch'));
    expect((spies.pinch.mock.calls[1]?.[0] as { scale: number }).scale).toBeCloseTo(100 / 150);
  });

  it('turns a drag into a pinch when a second finger lands, ending the drag', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0, 'touch'));
    recognizer.pointerMove(p(1, 40, 0, 'touch'));
    recognizer.pointerDown(p(2, 100, 0, 'touch'));
    expect(spies.dragEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores the remaining finger after a pinch: no tap, no drag', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0, 'touch'));
    recognizer.pointerDown(p(2, 100, 0, 'touch'));
    recognizer.pointerUp(p(2, 100, 0, 'touch'));
    recognizer.pointerMove(p(1, 80, 0, 'touch'));
    recognizer.pointerUp(p(1, 80, 0, 'touch'));
    expect(spies.tap).not.toHaveBeenCalled();
    expect(spies.dragStart).not.toHaveBeenCalled();
    expect(recognizer.activePointers).toBe(0);
    recognizer.pointerDown(p(3, 5, 5, 'touch'));
    recognizer.pointerUp(p(3, 5, 5, 'touch'));
    expect(spies.tap).toHaveBeenCalledTimes(1);
  });

  it('does not emit a pinch when both fingers start on the same spot', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerDown(p(1, 10, 10, 'touch'));
    recognizer.pointerDown(p(2, 10, 10, 'touch'));
    recognizer.pointerMove(p(2, 30, 10, 'touch'));
    expect(spies.pinch).not.toHaveBeenCalled();
  });

  it('cancel ends a drag without a tap and clears the long-press timer', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0));
    recognizer.pointerMove(p(1, 30, 0));
    recognizer.pointerCancel(1);
    expect(spies.dragEnd).toHaveBeenCalledTimes(1);
    expect(spies.tap).not.toHaveBeenCalled();
    expect(timers.count).toBe(0);
  });

  it('cancelAll drops pointers silently', () => {
    const { recognizer, timers, spies, p } = setup();
    recognizer.pointerDown(p(1, 0, 0));
    recognizer.pointerDown(p(2, 50, 0));
    recognizer.cancelAll();
    expect(recognizer.activePointers).toBe(0);
    timers.advance(1000);
    expect(spies.longPress).not.toHaveBeenCalled();
    expect(spies.tap).not.toHaveBeenCalled();
  });

  it('ignores moves and releases for pointers it never saw, and duplicate downs', () => {
    const { recognizer, spies, p } = setup();
    recognizer.pointerMove(p(9, 5, 5));
    recognizer.pointerUp(p(9, 5, 5));
    recognizer.pointerDown(p(1, 0, 0));
    recognizer.pointerDown(p(1, 0, 0));
    expect(recognizer.activePointers).toBe(1);
    expect(spies.tap).not.toHaveBeenCalled();
  });
});
