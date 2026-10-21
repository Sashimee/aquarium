import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import { FeedGate } from '../../sync/feedGate';
import type { PlantPick } from '../../scene/plantGrowth';
import type { Vec3 } from '../camera';
import type { InteractionEvents } from '../events';
import type { ReachBridge } from '../food/clipReach';
import { SimUnavailableError } from '../simUnavailable';
import { FoodLink } from '../food/link';
import { FoodField, MAX_FOOD_PARTICLES } from '../food/particles';
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

function makeController(
  ray: Ray | null = frontRay(),
  reach?: ReachBridge,
  report?: (message: string, cause: unknown) => void,
) {
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
  const pickPlant = vi.fn<(ray: Ray) => PlantPick | null>(() => null);
  const pickFish = vi.fn<(ray: Ray) => (() => Vec3 | null) | null>(() => null);
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
    pickPlant,
    pickFish,
    toSim: sceneToSim,
    reach,
    report,
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
    pickPlant,
    pickFish,
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

  it('announces each glass tap with its intensity, and nothing for a miss', () => {
    const t = makeController();
    const tapped = vi.fn();
    t.events.on('glass:tapped', tapped);
    t.controller.tap(0, 0);
    t.advance(200);
    t.controller.tap(0, 0);
    expect(tapped.mock.calls).toEqual([[{ intensity: 0.5 }], [{ intensity: 1 }]]);
    t.setRay(null);
    t.controller.tap(0, 0);
    expect(tapped).toHaveBeenCalledTimes(2);
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

describe('PlayController trim', () => {
  const pick = { key: 's7', size: 1.6, minSize: 0.4, maxSize: 2.4, distance: 0.5 };

  it('reports the plant under the tap and does not startle the fish', () => {
    const t = makeController();
    t.pickPlant.mockReturnValue(pick);
    const seen = vi.fn();
    t.events.on('plant:picked', seen);
    t.controller.setTool('trim');
    t.controller.tap(10, 10);
    expect(t.pickPlant).toHaveBeenCalledWith(frontRay());
    expect(seen).toHaveBeenCalledWith({ pick });
    expect(t.startle).not.toHaveBeenCalled();
  });

  it('reports a miss as null', () => {
    const t = makeController();
    const seen = vi.fn();
    t.events.on('plant:picked', seen);
    t.controller.setTool('trim');
    t.controller.tap(10, 10);
    expect(seen).toHaveBeenCalledWith({ pick: null });
  });

  it('does nothing with other tools or without a camera ray', () => {
    const t = makeController();
    const seen = vi.fn();
    t.events.on('plant:picked', seen);
    t.controller.tap(10, 10);
    t.controller.setTool('trim');
    t.setRay(null);
    t.controller.tap(10, 10);
    expect(seen).not.toHaveBeenCalled();
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

  it('reports the portion the rounded particle count stands for, not the one asked for', () => {
    const t = makeController();
    t.events.emit('feed:request', { food: 'pellets', portion: 0.33 });
    expect(t.seen.dropped).toHaveBeenCalledWith({ food: 'pellets', portion: 0.35, particles: 7 });
  });

  it('reports only the portion that fit when the tank is nearly full', () => {
    const t = makeController();
    t.food.drop('brine-shrimp', (MAX_FOOD_PARTICLES - 10) / 50, 0, 0);
    t.events.emit('feed:request', { food: 'pellets', portion: 1 });
    expect(t.seen.dropped).toHaveBeenCalledWith({ food: 'pellets', portion: 0.5, particles: 10 });
  });

  it('gives the feed slot back when the tank is full, so a retry is not rate limited', () => {
    const t = makeController();
    t.food.drop('brine-shrimp', MAX_FOOD_PARTICLES / 50, 0, 0);
    t.events.emit('feed:request', { food: 'flakes', portion: 1 });
    t.food.remove(t.food.particles.map((p) => p.id));
    t.events.emit('feed:request', { food: 'flakes', portion: 1 });
    expect(t.seen.rejected).toHaveBeenCalledTimes(1);
    expect(t.seen.dropped).toHaveBeenCalledTimes(1);
  });

  it('steps the food each frame', () => {
    const t = makeController();
    t.events.emit('feed:request', { food: 'pellets', portion: 1 });
    const y = t.food.particles[0]?.y ?? 0;
    for (let i = 0; i < 30; i++) t.controller.update(1 / 30);
    expect(t.food.particles[0]?.y).toBeLessThan(y);
  });
});

describe('PlayController fishAt', () => {
  it('hands the picked fish to the caller, from the ray under the point', () => {
    const t = makeController();
    const where = () => ({ x: 0.1, y: 0.2, z: 0.0 });
    t.pickFish.mockReturnValueOnce(where);
    expect(t.controller.fishAt(5, 5)).toBe(where);
    expect(t.pickFish).toHaveBeenCalledWith(frontRay());
  });

  it('finds nothing when the ray misses every fish or the camera is not ready', () => {
    const t = makeController();
    expect(t.controller.fishAt(5, 5)).toBeNull();
    t.setRay(null);
    expect(t.controller.fishAt(5, 5)).toBeNull();
    expect(t.pickFish).toHaveBeenCalledTimes(1);
  });
});

describe('PlayController nori clip placement', () => {
  const clipTo = (t: ReturnType<typeof makeController>) => {
    t.events.emit('feed:select', { food: 'nori' });
    t.controller.setTool('feed');
    t.controller.tap(0, 0);
  };
  const grazers = (canGraze: (y: number) => boolean) => ({
    noriGrazers: () => ['yellow-tang', 'blue-tang'],
    canGrazeAt: vi.fn((species: string, p: readonly [number, number, number]) =>
      Promise.resolve(species === 'yellow-tang' && canGraze(p[1])),
    ),
  });

  it('keeps a clip that any nori grazer can reach and then says it was fed', async () => {
    const bridge = grazers(() => true);
    const t = makeController(downRay(), bridge);
    clipTo(t);
    expect(t.seen.dropped).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(t.food.particles).toHaveLength(1);
    expect(t.seen.rejected).not.toHaveBeenCalled();
  });

  it('raises a clip in 2 cm steps until a grazer can turn at it', async () => {
    const t = makeController(
      downRay(),
      grazers((y) => y >= 0.37),
    );
    clipTo(t);
    const before = t.food.particles[0]?.y ?? 0;
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    const after = t.food.particles[0]?.y ?? 0;
    expect(after).toBeGreaterThanOrEqual(0.37);
    expect(after - before).toBeCloseTo(Math.ceil((0.37 - before) / 0.02) * 0.02, 6);
  });

  it('removes the clip and says why when no height works', async () => {
    const t = makeController(
      downRay(),
      grazers(() => false),
    );
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.rejected).toHaveBeenCalledTimes(1));
    expect(t.seen.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unreachable' }),
    );
    expect(t.food.particles).toHaveLength(0);
    expect(t.seen.dropped).not.toHaveBeenCalled();
  });

  it('reports only the portion of the clips that were kept', async () => {
    let asked = 0;
    const t = makeController(downRay(), {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => Promise.resolve(asked++ === 0),
    });
    t.events.emit('feed:request', { food: 'nori', portion: 1 });
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(t.seen.dropped).toHaveBeenCalledWith({ food: 'nori', portion: 0.5, particles: 1 });
    expect(t.food.particles).toHaveLength(1);
  });

  it('gives the feed slot back when every clip is refused', async () => {
    const t = makeController(downRay(), {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => Promise.resolve(false),
    });
    t.events.emit('feed:request', { food: 'nori', portion: 1 });
    await vi.waitFor(() => expect(t.seen.rejected).toHaveBeenCalledTimes(1));
    t.events.emit('feed:request', { food: 'nori', portion: 1 });
    await vi.waitFor(() => expect(t.seen.rejected).toHaveBeenCalledTimes(2));
    expect(t.seen.rejected).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'rate-limited' }),
    );
  });

  it('reports an unexpected sim error and keeps the clip', async () => {
    const report = vi.fn();
    const bridge = {
      noriGrazers: () => ['no-such-fish'],
      canGrazeAt: () => Promise.reject(new Error('canGrazeAt: unknown species "no-such-fish"')),
    };
    const t = makeController(downRay(), bridge, report);
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it('reports a plain error even when its message sounds like the sim is unavailable', async () => {
    const report = vi.fn();
    const bridge = {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => Promise.reject(new Error('The fish sim is not ready')),
    };
    const t = makeController(downRay(), bridge, report);
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('does not report the sim being unavailable', async () => {
    const report = vi.fn();
    const bridge = {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => Promise.reject(new SimUnavailableError('sim: client disposed')),
    };
    const t = makeController(downRay(), bridge, report);
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(report).not.toHaveBeenCalled();
  });

  it('allows the clip when the sim cannot answer', async () => {
    const bridge = {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => Promise.reject(new SimUnavailableError()),
    };
    const t = makeController(downRay(), bridge);
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(t.food.particles).toHaveLength(1);
  });

  it('skips the check when no fish in the tank eats nori', async () => {
    const canGrazeAt = vi.fn();
    const t = makeController(downRay(), { noriGrazers: () => [], canGrazeAt });
    clipTo(t);
    await vi.waitFor(() => expect(t.seen.dropped).toHaveBeenCalledTimes(1));
    expect(canGrazeAt).not.toHaveBeenCalled();
  });

  it('ignores a stale answer for a clip that was eaten meanwhile', async () => {
    let answer: (reachable: boolean) => void = () => undefined;
    const bridge = {
      noriGrazers: () => ['yellow-tang'],
      canGrazeAt: () => new Promise<boolean>((resolve) => (answer = resolve)),
    };
    const t = makeController(downRay(), bridge);
    clipTo(t);
    const [clip] = t.food.particles;
    t.food.remove([clip?.id ?? -1]);
    answer(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.seen.rejected).toHaveBeenCalledTimes(0);
    expect(t.seen.dropped).toHaveBeenCalledTimes(0);
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

  it('clears the dot and the lure when disposed while the laser is lit', () => {
    const t = makeController();
    t.controller.setTool('laser');
    t.controller.pointerMove(5, 5);
    t.lure.mockClear();
    t.controller.dispose();
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
