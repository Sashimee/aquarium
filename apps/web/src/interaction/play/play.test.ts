import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import { FeedGate } from '../../sync/feedGate';
import type { InteractionEvents } from '../events';
import { FoodLink } from '../food/link';
import { FoodField } from '../food/particles';
import { sceneToSim } from '../food/simSpace';
import { BubbleField } from './bubbles';
import { PlayController, type Ray } from './controller';
import { pickPlaneY, pickTankBox } from './pick';
import { RIPPLE_DURATION_S, RippleField } from './ripples';
import { TapIntensity } from './tapIntensity';

const MIN = { x: -0.59, y: 0.011, z: -0.24 };
const MAX = { x: 0.59, y: 0.47, z: 0.24 };

describe('pickTankBox', () => {
  it('enters the front face of the box from a camera in front', () => {
    const pick = pickTankBox({ x: 0.1, y: 0.3, z: 1.6 }, { x: 0, y: 0, z: -1 }, MIN, MAX);
    expect(pick?.face).toBe('front');
    expect(pick?.point.z).toBeCloseTo(0.24);
    expect(pick?.normal).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('identifies the back, side and top faces', () => {
    const o = { x: 0, y: 0.3, z: -1.6 };
    expect(pickTankBox(o, { x: 0, y: 0, z: 1 }, MIN, MAX)?.face).toBe('back');
    expect(pickTankBox({ x: -2, y: 0.3, z: 0 }, { x: 1, y: 0, z: 0 }, MIN, MAX)?.face).toBe('left');
    expect(pickTankBox({ x: 2, y: 0.3, z: 0 }, { x: -1, y: 0, z: 0 }, MIN, MAX)?.face).toBe(
      'right',
    );
    expect(pickTankBox({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, MIN, MAX)?.face).toBe('top');
  });

  it('misses a ray that passes beside the tank', () => {
    expect(pickTankBox({ x: 3, y: 0.3, z: 1.6 }, { x: 0, y: 0, z: -1 }, MIN, MAX)).toBeNull();
  });

  it('returns null for a ray pointing away or starting inside', () => {
    expect(pickTankBox({ x: 0, y: 0.3, z: 1.6 }, { x: 0, y: 0, z: 1 }, MIN, MAX)).toBeNull();
    expect(pickTankBox({ x: 0, y: 0.3, z: 0 }, { x: 0, y: 0, z: 1 }, MIN, MAX)).toBeNull();
  });

  it('handles a ray parallel to a slab outside it', () => {
    expect(pickTankBox({ x: 0, y: 0.9, z: 1.6 }, { x: 0, y: 0, z: -1 }, MIN, MAX)).toBeNull();
  });
});

describe('pickPlaneY', () => {
  it('hits the water plane from above and refuses horizontal or upward rays', () => {
    const hit = pickPlaneY({ x: 0, y: 1, z: 1 }, { x: 0, y: -0.5, z: -0.5 }, 0.47);
    expect(hit?.y).toBe(0.47);
    expect(hit?.z).toBeCloseTo(0.47);
    expect(pickPlaneY({ x: 0, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, 0.47)).toBeNull();
    expect(pickPlaneY({ x: 0, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }, 0.47)).toBeNull();
  });
});

describe('TapIntensity', () => {
  it('reads a quick second tap as a hard knock', () => {
    const t = new TapIntensity();
    expect(t.next(1000)).toBe(0.5);
    expect(t.next(1200)).toBe(1);
    expect(t.next(5000)).toBe(0.5);
  });
});

describe('RippleField', () => {
  it('expands, fades and expires', () => {
    const field = new RippleField();
    field.add({ x: 0, y: 0.2, z: 0.24 }, { x: 0, y: 0, z: -1 }, 1);
    const r = field.ripples[0];
    if (!r) throw new Error('no ripple');
    expect(RippleField.radius(r)).toBe(0);
    field.step(RIPPLE_DURATION_S / 2);
    const mid = RippleField.radius(r);
    expect(mid).toBeGreaterThan(0.05);
    expect(RippleField.opacity(r)).toBeLessThan(0.2);
    field.step(RIPPLE_DURATION_S);
    expect(field.ripples).toHaveLength(0);
  });

  it('drops the oldest ripple when full', () => {
    const field = new RippleField();
    for (let i = 0; i < 20; i++) field.add({ x: i, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0.5);
    expect(field.ripples).toHaveLength(8);
    expect(field.ripples[0]?.origin.x).toBe(12);
  });
});

describe('BubbleField', () => {
  it('rises and pops at the surface', () => {
    const field = new BubbleField(0.47, () => 0.5);
    field.emit(0, 0.1, 0.2, 3);
    expect(field.bubbles).toHaveLength(3);
    const y0 = field.bubbles[0]?.y ?? 0;
    field.step(0.5);
    expect(field.bubbles[0]?.y).toBeGreaterThan(y0);
    for (let i = 0; i < 40; i++) field.step(0.1);
    expect(field.bubbles).toHaveLength(0);
  });

  it('caps the number of bubbles', () => {
    const field = new BubbleField(0.47);
    expect(field.emit(0, 0.1, 0, 1000)).toBe(160);
    expect(field.emit(0, 0.1, 0, 1)).toBe(0);
  });
});

function frontRay(x = 0, y = 0.3): Ray {
  return { origin: { x, y, z: 1.6 }, dir: { x: 0, y: 0, z: -1 } };
}

function downRay(x = 0.1, z = 0.05): Ray {
  return { origin: { x, y: 1, z }, dir: { x: 0, y: -1, z: 0 } };
}

function makeController(ray: Ray | null = frontRay()) {
  const events = new EventBus<InteractionEvents>();
  const food = new FoodField(
    {
      bounds: { minX: MIN.x, maxX: MAX.x, minZ: MIN.z, maxZ: MAX.z, waterTop: MAX.y },
      groundHeight: () => 0.06,
      current: (_x, _y, _z, out) => {
        out[0] = out[1] = out[2] = 0;
      },
    },
    () => 0.5,
  );
  const bubbles = new BubbleField(MAX.y, () => 0.5);
  const startle = vi.fn();
  const netTap = vi.fn();
  const lure = vi.fn();
  const setLaserDot = vi.fn();
  let now = 10_000;
  let currentRay = ray;
  const controller = new PlayController({
    rayAt: () => currentRay,
    min: MIN,
    max: MAX,
    food,
    link: new FoodLink(food, {}, sceneToSim, () => undefined),
    bubbles,
    ripples: new RippleField(),
    gate: new FeedGate({ cooldownMs: 1000 }),
    events,
    startle,
    netTap,
    toSim: sceneToSim,
    lure,
    setLaserDot,
    now: () => now,
  });
  const seen = {
    dropped: vi.fn(),
    rejected: vi.fn(),
    tool: vi.fn(),
  };
  events.on('feed:dropped', seen.dropped);
  events.on('feed:rejected', seen.rejected);
  events.on('play:tool-changed', seen.tool);
  return {
    controller,
    events,
    food,
    bubbles,
    startle,
    netTap,
    lure,
    setLaserDot,
    seen,
    setRay: (r: Ray | null) => {
      currentRay = r;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PlayController glass tap', () => {
  it('startles at the tapped glass point in tank space and adds a ripple', () => {
    const t = makeController();
    t.controller.tap(10, 10);
    expect(t.startle).toHaveBeenCalledTimes(1);
    const stimulus = t.startle.mock.calls[0]?.[0] as {
      position: number[];
      intensity: number;
    };
    expect(stimulus.position[0]).toBeCloseTo(0);
    expect(stimulus.position[1]).toBeCloseTo(0.3);
    expect(stimulus.position[2]).toBeCloseTo(0.24);
    expect(stimulus.intensity).toBe(0.5);
  });

  it('makes a repeat tap harder', () => {
    const t = makeController();
    t.controller.tap(0, 0);
    t.advance(200);
    t.controller.tap(0, 0);
    expect(t.startle.mock.calls[1]?.[0].intensity).toBe(1);
  });

  it('ignores taps that miss the tank and taps with no camera ray', () => {
    const t = makeController(frontRay(5));
    t.controller.tap(0, 0);
    t.setRay(null);
    t.controller.tap(0, 0);
    expect(t.startle).not.toHaveBeenCalled();
  });

  it('ripples the water surface without startling fish', () => {
    const t = makeController(downRay());
    t.controller.tap(0, 0);
    expect(t.startle).not.toHaveBeenCalled();
  });

  it('works with no sim attached', () => {
    const t = makeController();
    expect(() => t.controller.tap(0, 0)).not.toThrow();
  });
});

describe('PlayController net', () => {
  it('hands the tap ray to the fish pick instead of tapping the glass', () => {
    const t = makeController();
    t.controller.setTool('net');
    t.controller.tap(10, 10);
    expect(t.netTap).toHaveBeenCalledWith(frontRay());
    expect(t.startle).not.toHaveBeenCalled();
  });

  it('does not net with other tools or without a camera ray', () => {
    const t = makeController();
    t.controller.tap(10, 10);
    t.controller.setTool('feed');
    t.controller.tap(10, 10);
    t.controller.setTool('net');
    t.setRay(null);
    t.controller.tap(10, 10);
    expect(t.netTap).not.toHaveBeenCalled();
  });
});

describe('PlayController feeding', () => {
  it('drops at the tank centre on a feed request and announces it', () => {
    const t = makeController();
    t.events.emit('feed:request', { food: 'pellets', portion: 1 });
    expect(t.food.count).toBe(20);
    expect(t.seen.dropped).toHaveBeenCalledWith({ food: 'pellets', portion: 1, particles: 20 });
  });

  it('hand-feeds at the water point under the pointer', () => {
    const t = makeController(downRay(0.3, 0.1));
    t.controller.setTool('feed');
    t.controller.tap(0, 0);
    const xs = t.food.particles.map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThan(0.25);
    expect(Math.max(...xs)).toBeLessThan(0.35);
  });

  it('hand-feeds the food selected in the UI, not the last one fed', () => {
    const t = makeController(downRay());
    t.events.emit('feed:select', { food: 'nori' });
    t.controller.setTool('feed');
    t.controller.tap(0, 0);
    expect(t.seen.dropped).toHaveBeenCalledWith(expect.objectContaining({ food: 'nori' }));
    expect(t.food.particles.every((p) => p.food === 'nori')).toBe(true);
  });

  it('ignores hand-feed taps that miss the water and keeps the feed gate unspent', () => {
    const t = makeController(downRay(2, 0));
    t.controller.setTool('feed');
    t.controller.tap(0, 0);
    t.setRay(frontRay());
    t.controller.tap(0, 0);
    t.setRay(null);
    t.controller.tap(0, 0);
    expect(t.food.count).toBe(0);
    expect(t.seen.dropped).not.toHaveBeenCalled();
    expect(t.seen.rejected).not.toHaveBeenCalled();
    t.setRay(downRay());
    t.controller.tap(0, 0);
    expect(t.seen.dropped).toHaveBeenCalledTimes(1);
  });

  it('refuses repeat feeds inside the cooldown', () => {
    const t = makeController();
    t.events.emit('feed:request', { food: 'flakes', portion: 1 });
    t.events.emit('feed:request', { food: 'flakes', portion: 1 });
    expect(t.seen.dropped).toHaveBeenCalledTimes(1);
    expect(t.seen.rejected).toHaveBeenCalledWith({ reason: 'rate-limited', retryAfterMs: 1000 });
  });

  it('refuses when the tank already holds the maximum of uneaten food', () => {
    const t = makeController();
    for (let i = 0; i < 60; i++) t.food.drop('brine-shrimp', 1, 0, 0);
    t.events.emit('feed:request', { food: 'flakes', portion: 1 });
    expect(t.seen.rejected).toHaveBeenCalledWith({ reason: 'tank-full', retryAfterMs: 0 });
    expect(t.seen.dropped).not.toHaveBeenCalled();
  });

  it('steps the food each frame', () => {
    const t = makeController();
    t.events.emit('feed:request', { food: 'pellets', portion: 1 });
    const y = t.food.particles[0]?.y ?? 0;
    for (let i = 0; i < 30; i++) t.controller.update(1 / 30);
    expect(t.food.particles[0]?.y).toBeLessThan(y);
  });
});

describe('PlayController laser and wand', () => {
  it('shows the laser dot on the glass and lures, and hides it off the tank', () => {
    const t = makeController();
    t.controller.setTool('laser');
    t.controller.pointerMove(5, 5);
    const dot = t.setLaserDot.mock.calls.at(-1)?.[0];
    expect(dot.z).toBeLessThan(0.24);
    expect(dot.z).toBeGreaterThan(0.2);
    expect(t.lure).toHaveBeenLastCalledWith(dot);
    t.setRay(frontRay(5));
    t.controller.pointerMove(5, 5);
    expect(t.setLaserDot).toHaveBeenLastCalledWith(null);
    expect(t.lure).toHaveBeenLastCalledWith(null);
  });

  it('claims the drag only for laser and wand', () => {
    const t = makeController();
    expect(t.controller.claimsDrag).toBe(false);
    t.controller.setTool('wand');
    expect(t.controller.claimsDrag).toBe(true);
    t.controller.setTool('laser');
    expect(t.controller.claimsDrag).toBe(true);
    t.controller.setTool('feed');
    expect(t.controller.claimsDrag).toBe(false);
  });

  it('emits bubbles only while the wand is pressed on the glass', () => {
    const t = makeController();
    t.controller.setTool('wand');
    t.controller.pointerMove(0, 0);
    t.controller.update(0.5);
    expect(t.bubbles.bubbles).toHaveLength(0);
    t.controller.pointerDown(0, 0);
    t.controller.update(1);
    const emitted = t.bubbles.bubbles.length;
    expect(emitted).toBeGreaterThan(8);
    expect(emitted).toBeLessThan(20);
    t.controller.pointerUp();
    t.controller.update(0.1);
    expect(t.bubbles.bubbles.length).toBeLessThanOrEqual(emitted);
  });

  it('resets the laser when the tool changes and announces the tool once', () => {
    const t = makeController();
    t.controller.setTool('laser');
    t.controller.setTool('laser');
    expect(t.seen.tool).toHaveBeenCalledTimes(1);
    t.controller.setTool('tap');
    expect(t.setLaserDot).toHaveBeenLastCalledWith(null);
  });
});
