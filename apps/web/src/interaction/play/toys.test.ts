import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../engine/events';
import { FeedGate } from '../../sync/feedGate';
import type { Vec3 } from '../camera';
import type { InteractionEvents } from '../events';
import { FoodLink } from '../food/link';
import { FoodField } from '../food/particles';
import { sceneToSim } from '../food/simSpace';
import { BubbleField } from './bubbles';
import {
  PlayController,
  type SimToy,
  type ToyNudge,
  type ToyVisuals,
  type StimulusLike,
} from './controller';
import {
  FeedingGame,
  LAST_PINCH_GRACE_S,
  localBest,
  PINCHES_PER_ROUND,
  ROUND_S,
  type BestStore,
} from './game';
import { RippleField } from './ripples';
import {
  BALL_RADIUS_M,
  MAX_BALL_SPEED,
  MIRROR_HEIGHT_M,
  MIRROR_WIDTH_M,
  mirrorMountFor,
  PingPongBall,
  type SurfaceCurrent,
} from './toys';

const MIN = { x: -0.59, y: 0.011, z: -0.24 };
const MAX = { x: 0.59, y: 0.47, z: 0.24 };
const BOUNDS = { minX: MIN.x, maxX: MAX.x, minZ: MIN.z, maxZ: MAX.z, waterTop: MAX.y };

const still: SurfaceCurrent = (_x, _y, _z, out) => {
  out[0] = out[1] = out[2] = 0;
};
const flowing =
  (vx: number, vz: number): SurfaceCurrent =>
  (_x, _y, _z, out) => {
    out[0] = vx;
    out[1] = 0;
    out[2] = vz;
  };

function run(ball: PingPongBall, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) ball.step(1 / 60);
}

describe('PingPongBall', () => {
  it('floats with most of its height above the water and bobs only a little', () => {
    const ball = new PingPongBall(BOUNDS, still, 0, 0);
    const ys: number[] = [];
    for (let i = 0; i < 120; i++) {
      ball.step(1 / 60);
      ys.push(ball.y);
    }
    expect(Math.min(...ys)).toBeGreaterThan(MAX.y);
    expect(Math.min(...ys)).toBeLessThan(MAX.y + BALL_RADIUS_M);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.005);
  });

  it('is dragged along by the current and settles to its speed', () => {
    const ball = new PingPongBall(BOUNDS, flowing(0.05, 0), -0.3, 0);
    run(ball, 4);
    expect(ball.x).toBeGreaterThan(-0.3 + 0.1);
    expect(ball.vx).toBeGreaterThan(0.035);
    expect(ball.vx).toBeLessThan(0.05);
    expect(ball.z).toBeCloseTo(0, 6);
  });

  it('slows to a stop in still water after a flick', () => {
    const ball = new PingPongBall(BOUNDS, still, 0, 0);
    ball.flick(0.6, 0);
    run(ball, 1);
    const early = ball.speed;
    run(ball, 8);
    expect(early).toBeLessThan(0.6);
    expect(ball.speed).toBeLessThan(0.02);
  });

  it('caps a flick at the maximum speed and keeps its direction', () => {
    const ball = new PingPongBall(BOUNDS, still, 0, 0);
    ball.flick(30, 40);
    expect(ball.speed).toBeCloseTo(MAX_BALL_SPEED, 6);
    expect(ball.vz / ball.vx).toBeCloseTo(40 / 30, 6);
  });

  it('bounces off the glass and never leaves the tank', () => {
    const ball = new PingPongBall(BOUNDS, still, 0.5, 0);
    ball.flick(1, 0.3);
    for (let i = 0; i < 600; i++) {
      ball.step(1 / 60);
      expect(ball.x).toBeLessThanOrEqual(MAX.x - BALL_RADIUS_M + 1e-9);
      expect(ball.x).toBeGreaterThanOrEqual(MIN.x + BALL_RADIUS_M - 1e-9);
      expect(ball.z).toBeLessThanOrEqual(MAX.z - BALL_RADIUS_M + 1e-9);
      expect(ball.z).toBeGreaterThanOrEqual(MIN.z + BALL_RADIUS_M - 1e-9);
    }
  });

  it('turns around at a wall with some energy lost', () => {
    const ball = new PingPongBall(BOUNDS, still, MAX.x - BALL_RADIUS_M - 0.01, 0);
    ball.flick(0.5, 0);
    run(ball, 0.5);
    expect(ball.vx).toBeLessThan(0);
    expect(Math.abs(ball.vx)).toBeLessThan(0.5);
  });

  it('stays put while held, even in a current', () => {
    const ball = new PingPongBall(BOUNDS, flowing(0.2, 0), 0, 0);
    ball.grab();
    run(ball, 2);
    expect(ball.x).toBe(0);
    ball.release(0, 0);
    run(ball, 1);
    expect(ball.x).toBeGreaterThan(0);
  });

  it('puts a ball placed outside the tank back inside', () => {
    const ball = new PingPongBall(BOUNDS, still, 5, -5);
    expect(ball.x).toBeCloseTo(MAX.x - BALL_RADIUS_M);
    expect(ball.z).toBeCloseTo(MIN.z + BALL_RADIUS_M);
  });

  it('takes a fish nudge as a small capped push', () => {
    const ball = new PingPongBall(BOUNDS, still, 0, 0);
    ball.nudge(0.1, 0);
    expect(ball.vx).toBeCloseTo(0.1);
    ball.nudge(5, 0);
    expect(ball.vx).toBeLessThanOrEqual(0.1 + 0.35 + 1e-9);
  });

  it('does not blow up on a long frame', () => {
    const ball = new PingPongBall(BOUNDS, still, 0, 0);
    ball.flick(1, 0);
    ball.step(30);
    expect(Number.isFinite(ball.x)).toBe(true);
    expect(ball.x).toBeLessThanOrEqual(MAX.x);
  });
});

describe('mirrorMountFor', () => {
  const box = { min: MIN, max: MAX };

  it('hangs on the back wall where a ray from the front reaches it, facing in', () => {
    const mount = mirrorMountFor({ x: 0.1, y: 0.3, z: 1.6 }, { x: 0, y: 0, z: -1 }, box);
    expect(mount?.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(mount?.position.x).toBeCloseTo(0.1);
    expect(mount?.position.y).toBeCloseTo(0.3);
    expect(mount?.position.z).toBeGreaterThan(MIN.z);
    expect(mount?.position.z).toBeLessThan(MIN.z + 0.01);
  });

  it('hangs on a side wall when the ray reaches that one first', () => {
    const mount = mirrorMountFor({ x: 1.5, y: 0.3, z: 0.2 }, { x: -1, y: 0, z: -0.05 }, box);
    expect(mount?.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(mount?.position.x).toBeLessThan(MAX.x);
    expect(mount?.position.x).toBeGreaterThan(MAX.x - 0.01);
  });

  it('keeps the whole mirror inside the wall, clear of the corners and the water line', () => {
    const mount = mirrorMountFor({ x: 0.58, y: 0.468, z: 1.6 }, { x: 0, y: 0, z: -1 }, box);
    expect(mount).not.toBeNull();
    const p = mount?.position as Vec3;
    expect(p.x).toBeLessThanOrEqual(MAX.x - MIRROR_WIDTH_M / 2 + 1e-9);
    expect(p.y).toBeLessThanOrEqual(MAX.y - MIRROR_HEIGHT_M / 2 + 1e-9);
    const low = mirrorMountFor({ x: 0, y: 0.02, z: 1.6 }, { x: 0, y: 0, z: -1 }, box);
    expect(low?.position.y).toBeGreaterThanOrEqual(MIN.y + MIRROR_HEIGHT_M / 2 - 1e-9);
  });

  it('mounts on the back wall for a ray that would leave through the floor', () => {
    const mount = mirrorMountFor({ x: 0, y: 1, z: 1 }, { x: 0, y: -1, z: -0.2 }, box);
    expect(mount?.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(mount?.position.y).toBeCloseTo(MIN.y + MIRROR_HEIGHT_M / 2);
  });

  it('refuses a ray that points away from the back wall and misses the sides', () => {
    expect(mirrorMountFor({ x: 0, y: 0.3, z: 1.6 }, { x: 0, y: 0, z: 1 }, box)).toBeNull();
    expect(mirrorMountFor({ x: 0, y: 0.3, z: 1.6 }, { x: 0, y: 1, z: 0 }, box)).toBeNull();
  });
});

function memoryStore(initial = 0): BestStore & { value: number } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (score: number) => {
      store.value = Math.max(store.value, score);
    },
  };
  return store;
}

const FISH = [
  { id: 'a', name: 'Bold', boldness: 0.9 },
  { id: 'b', name: 'Shy', boldness: 0.2 },
  { id: 'c', name: 'Middle', boldness: 0.5 },
];

describe('FeedingGame', () => {
  it('needs two fish', () => {
    const game = new FeedingGame(memoryStore());
    const view = game.start(FISH.slice(0, 1));
    expect(view.phase).toBe('unavailable');
    expect(game.running).toBe(false);
    expect(game.start([]).phase).toBe('unavailable');
  });

  it('picks the shyest fish as the target', () => {
    const game = new FeedingGame(memoryStore());
    const view = game.start(FISH);
    expect(view).toMatchObject({ phase: 'running', targetId: 'b', targetName: 'Shy' });
  });

  it('breaks a boldness tie with the random source', () => {
    const tied = [
      { id: 'x', name: 'X', boldness: 0.3 },
      { id: 'y', name: 'Y', boldness: 0.3 },
    ];
    expect(new FeedingGame(memoryStore(), () => 0).start(tied)).toMatchObject({ targetId: 'x' });
    expect(new FeedingGame(memoryStore(), () => 0.99).start(tied)).toMatchObject({
      targetId: 'y',
    });
  });

  it('gives five pinches and refuses a sixth', () => {
    const game = new FeedingGame(memoryStore());
    game.start(FISH);
    for (let i = 0; i < PINCHES_PER_ROUND; i++) expect(game.pinch()).toBe(true);
    expect(game.pinch()).toBe(false);
  });

  it('refunds a pinch that never reached the water', () => {
    const game = new FeedingGame(memoryStore());
    game.start(FISH);
    game.pinch();
    game.refund();
    expect(game.view).toMatchObject({ pinchesLeft: PINCHES_PER_ROUND });
    game.refund();
    expect(game.view).toMatchObject({ pinchesLeft: PINCHES_PER_ROUND });
  });

  it('refuses a pinch with no round', () => {
    expect(new FeedingGame(memoryStore()).pinch()).toBe(false);
  });

  it('scores the shy fish up and the rivals down, never below zero', () => {
    const game = new FeedingGame(memoryStore());
    game.start(FISH);
    game.ate([{ fishId: 'a', portion: 0.5 }]);
    expect(game.view).toMatchObject({ score: 0 });
    game.ate([{ fishId: 'b', portion: 0.4 }]);
    expect(game.view).toMatchObject({ score: 25 });
    game.ate([{ fishId: 'b', portion: 0.1 }]);
    expect(game.view).toMatchObject({ score: 35 });
  });

  it('ignores bites when no round is on', () => {
    const game = new FeedingGame(memoryStore());
    expect(game.ate([{ fishId: 'b', portion: 1 }]).phase).toBe('idle');
  });

  it('ends when the time is up and keeps a new best', () => {
    const store = memoryStore(10);
    const game = new FeedingGame(store);
    game.start(FISH);
    game.ate([{ fishId: 'b', portion: 0.6 }]);
    expect(game.update(ROUND_S - 1).phase).toBe('running');
    const done = game.update(1.5);
    expect(done).toMatchObject({ phase: 'done', score: 60, newBest: true, targetAte: true });
    expect(store.value).toBe(60);
    expect(game.running).toBe(false);
  });

  it('ends early once the last pinch has had time to be eaten', () => {
    const game = new FeedingGame(memoryStore());
    game.start(FISH);
    for (let i = 0; i < PINCHES_PER_ROUND; i++) game.pinch();
    expect(game.update(LAST_PINCH_GRACE_S - 0.5).phase).toBe('running');
    expect(game.update(1).phase).toBe('done');
  });

  it('keeps the old best on a worse round and reports a round where the shy fish starved', () => {
    const store = memoryStore(80);
    const game = new FeedingGame(store);
    game.start(FISH);
    game.ate([{ fishId: 'a', portion: 1 }]);
    const done = game.finish();
    expect(done).toMatchObject({
      phase: 'done',
      score: 0,
      best: 80,
      newBest: false,
      targetAte: false,
    });
    expect(store.value).toBe(80);
  });

  it('can be cancelled without scoring', () => {
    const store = memoryStore(5);
    const game = new FeedingGame(store);
    game.start(FISH);
    game.ate([{ fishId: 'b', portion: 1 }]);
    expect(game.cancel()).toEqual({ phase: 'idle', best: 5 });
    expect(store.value).toBe(5);
  });
});

describe('localBest', () => {
  it('round-trips the best through storage and ignores junk', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    const report = vi.fn();
    const best = localBest(storage, report);
    expect(best.read()).toBe(0);
    best.write(40);
    expect(localBest(storage, report).read()).toBe(40);
    data.set('aquarium.feeding-game.best', 'banana');
    expect(localBest(storage, report).read()).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a store that throws and keeps the best for the session', () => {
    const report = vi.fn();
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const best = localBest(storage, report);
    expect(best.read()).toBe(0);
    best.write(30);
    expect(best.read()).toBe(30);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('works with no storage at all', () => {
    const best = localBest(null, vi.fn());
    best.write(12);
    expect(best.read()).toBe(12);
  });
});

function makeToyController() {
  const events = new EventBus<InteractionEvents>();
  const food = new FoodField(
    { bounds: BOUNDS, groundHeight: () => 0.06, current: still },
    () => 0.5,
  );
  const visuals = {
    setMirror: vi.fn<ToyVisuals['setMirror']>(),
    setBall: vi.fn<ToyVisuals['setBall']>(),
    setHighlight: vi.fn<ToyVisuals['setHighlight']>(),
  };
  const setToys = vi.fn<(toys: readonly SimToy[]) => void>();
  let nudge: ((n: ToyNudge) => void) | null = null;
  let now = 1000;
  const store = memoryStore();
  const game = new FeedingGame(store);
  const controller = new PlayController({
    rayAt: (x, y) => ({ origin: { x, y: 1, z: y }, dir: { x: 0, y: -1, z: 0 } }),
    min: MIN,
    max: MAX,
    food,
    link: new FoodLink(food, {}, sceneToSim, () => undefined),
    bubbles: new BubbleField(MAX.y, () => 0.5),
    ripples: new RippleField(),
    gate: new FeedGate({ cooldownMs: 0 }),
    events,
    startle: vi.fn<(s: StimulusLike) => void>(),
    toSim: sceneToSim,
    setLaserDot: vi.fn(),
    current: flowing(0, 0),
    toyVisuals: visuals,
    setToys,
    onToyNudge: (listener) => {
      nudge = listener;
      return () => {
        nudge = null;
      };
    },
    boldnessOf: (species) => (species === 'shy-fish' ? 0.1 : 0.8),
    game,
    now: () => now,
  });
  const toysSeen = vi.fn();
  const gameSeen = vi.fn();
  events.on('toys:changed', toysSeen);
  events.on('game:state', gameSeen);
  return {
    controller,
    events,
    food,
    visuals,
    setToys,
    toysSeen,
    gameSeen,
    store,
    game,
    advance: (ms: number) => {
      now += ms;
    },
    nudge: (n: ToyNudge) => nudge?.(n),
    nudgeBound: () => nudge !== null,
  };
}

const ROSTER = [
  { id: 'f1', name: 'Rex', species: 'bold-fish' },
  { id: 'f2', name: 'Pip', species: 'shy-fish' },
];

describe('ping-pong ball in the controller', () => {
  it('appears where the surface is tapped and is announced', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    expect(t.controller.claimsDrag).toBe(true);
    t.controller.pointerDown(0.2, 0.1);
    t.controller.pointerUp();
    expect(t.controller.hasBall).toBe(true);
    expect(t.toysSeen).toHaveBeenLastCalledWith({ mirror: false, ball: true });
    t.controller.update(1 / 60);
    const at = t.visuals.setBall.mock.calls.at(-1)?.[0];
    expect(at?.x).toBeCloseTo(0.2);
    expect(at?.z).toBeCloseTo(0.1);
    expect(at?.y).toBeGreaterThan(MAX.y);
  });

  it('drops from above the spot where the glass is tapped when the surface is edge-on', () => {
    const events = new EventBus<InteractionEvents>();
    const food = new FoodField({ bounds: BOUNDS, groundHeight: () => 0, current: still });
    const visuals = { setMirror: vi.fn(), setBall: vi.fn(), setHighlight: vi.fn() };
    const controller = new PlayController({
      rayAt: () => ({ origin: { x: 0.2, y: 0.3, z: 1.6 }, dir: { x: 0, y: 0, z: -1 } }),
      min: MIN,
      max: MAX,
      food,
      link: new FoodLink(food, {}, sceneToSim, () => undefined),
      bubbles: new BubbleField(MAX.y),
      ripples: new RippleField(),
      gate: new FeedGate(),
      events,
      toSim: sceneToSim,
      setLaserDot: vi.fn(),
      toyVisuals: visuals,
      now: () => 0,
    });
    controller.setTool('ball');
    controller.pointerDown(1, 1);
    controller.update(1 / 60);
    const at = visuals.setBall.mock.calls.at(-1)?.[0];
    expect(at?.x).toBeCloseTo(0.2);
    expect(at?.z).toBeCloseTo(MAX.z - BALL_RADIUS_M);
    expect(at?.y).toBeGreaterThan(MAX.y);
  });

  it('flicks away at the speed of the drag and then slows', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.controller.update(1 / 60);
    for (let i = 1; i <= 4; i++) {
      t.advance(16);
      t.controller.pointerMove(i * 0.008, 0);
    }
    t.controller.pointerUp();
    t.controller.update(0.1);
    const early = t.visuals.setBall.mock.calls.at(-1)?.[0];
    expect(early?.x).toBeGreaterThan(0.032);
    for (let i = 0; i < 60 * 8; i++) t.controller.update(1 / 60);
    const late = t.visuals.setBall.mock.calls.at(-1)?.[0];
    expect(late?.x).toBeGreaterThan(early?.x ?? 0);
    expect(late?.x).toBeLessThan(MAX.x - BALL_RADIUS_M + 1e-6);
  });

  it('lets go without a flick when the pointer rested before release', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.advance(16);
    t.controller.pointerMove(0.05, 0);
    t.advance(500);
    t.controller.pointerUp();
    t.controller.update(1);
    const at = t.visuals.setBall.mock.calls.at(-1)?.[0];
    expect(at?.x).toBeCloseTo(0.05, 2);
  });

  it('does not grab the ball from far away, and does not move it', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.controller.pointerUp();
    t.controller.pointerDown(0.4, 0);
    t.advance(16);
    t.controller.pointerMove(0.45, 0);
    t.controller.pointerUp();
    t.controller.update(1 / 60);
    const at = t.visuals.setBall.mock.calls.at(-1)?.[0];
    expect(at?.x).toBeCloseTo(0, 1);
  });

  it('gives the sim the ball as a point of interest and takes fish nudges', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.controller.pointerUp();
    t.controller.update(1 / 60);
    const toys = t.setToys.mock.calls.at(-1)?.[0] ?? [];
    expect(toys).toHaveLength(1);
    expect(toys[0]?.kind).toBe('ball');
    t.nudge({ ix: 0.2, iz: 0 });
    t.controller.update(0.2);
    const moved = t.setToys.mock.calls.at(-1)?.[0]?.[0];
    expect(moved?.kind === 'ball' && moved.position[0]).toBeGreaterThan(0);
  });

  it('is removed on request', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.controller.pointerUp();
    t.events.emit('toys:remove', { toy: 'ball' });
    expect(t.controller.hasBall).toBe(false);
    expect(t.visuals.setBall).toHaveBeenLastCalledWith(null);
    expect(t.toysSeen).toHaveBeenLastCalledWith({ mirror: false, ball: false });
    expect(t.setToys).toHaveBeenLastCalledWith([]);
  });

  it('is released when another tool is picked mid-drag', () => {
    const t = makeToyController();
    t.controller.setTool('ball');
    t.controller.pointerDown(0, 0);
    t.controller.setTool('tap');
    for (let i = 0; i < 30; i++) t.controller.update(1 / 60);
    expect(t.controller.hasBall).toBe(true);
  });
});

describe('mirror in the controller', () => {
  const backRay = { origin: { x: 0.1, y: 0.3, z: 1.6 }, dir: { x: 0, y: 0, z: -1 } };

  it('hangs on the glass and tells the sim where, in its own frame', () => {
    const events = new EventBus<InteractionEvents>();
    const setToys = vi.fn<(toys: readonly SimToy[]) => void>();
    const visuals = { setMirror: vi.fn(), setBall: vi.fn(), setHighlight: vi.fn() };
    const food = new FoodField({ bounds: BOUNDS, groundHeight: () => 0, current: still });
    const controller = new PlayController({
      rayAt: () => backRay,
      min: MIN,
      max: MAX,
      food,
      link: new FoodLink(food, {}, sceneToSim, () => undefined),
      bubbles: new BubbleField(MAX.y),
      ripples: new RippleField(),
      gate: new FeedGate(),
      events,
      toSim: sceneToSim,
      setLaserDot: vi.fn(),
      toyVisuals: visuals,
      setToys,
      now: () => 0,
    });
    const seen = vi.fn();
    events.on('toys:changed', seen);
    controller.setTool('mirror');
    controller.tap(5, 5);
    expect(controller.hasMirror).toBe(true);
    expect(seen).toHaveBeenLastCalledWith({ mirror: true, ball: false });
    expect(visuals.setMirror.mock.calls.at(-1)?.[0]?.normal).toEqual({ x: 0, y: 0, z: 1 });
    const toy = setToys.mock.calls.at(-1)?.[0]?.[0];
    expect(toy?.kind).toBe('mirror');
    expect(toy?.position[0]).toBeCloseTo(0.1);
    expect(toy?.position[2]).toBeCloseTo(MIN.z + 0.004);
    expect(toy && 'normal' in toy && toy.normal).toEqual([0, 0, 1]);

    controller.tap(5, 5);
    expect(setToys.mock.calls.at(-1)?.[0]).toHaveLength(1);

    events.emit('toys:remove', { toy: 'mirror' });
    expect(controller.hasMirror).toBe(false);
    expect(setToys).toHaveBeenLastCalledWith([]);
    expect(visuals.setMirror).toHaveBeenLastCalledWith(null);
  });

  it('ignores a tap that finds no wall', () => {
    const t = makeToyController();
    t.controller.setTool('mirror');
    t.controller.tap(0, 0);
    expect(t.controller.hasMirror).toBe(false);
  });
});

describe('feeding game in the controller', () => {
  it('starts a round on the game tool and drops a pinch per tap', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER });
    expect(t.controller.tool).toBe('game');
    expect(t.gameSeen).toHaveBeenLastCalledWith({
      view: expect.objectContaining({ phase: 'running', targetId: 'f2', pinchesLeft: 5 }),
    });
    const dropped = vi.fn();
    t.events.on('feed:dropped', dropped);
    t.controller.tap(0.1, 0.1);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped.mock.calls[0]?.[0].food).toBe('flakes');
    expect(t.food.count).toBeGreaterThan(0);
    expect(t.gameSeen).toHaveBeenLastCalledWith({
      view: expect.objectContaining({ pinchesLeft: 4 }),
    });
  });

  it('does not drop food on a game-tool tap when no round is on', () => {
    const t = makeToyController();
    t.controller.setTool('game');
    t.controller.tap(0.1, 0.1);
    expect(t.food.count).toBe(0);
  });

  it('refuses to start with a single fish and stays on the current tool', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER.slice(0, 1) });
    expect(t.controller.tool).toBe('tap');
    expect(t.gameSeen).toHaveBeenLastCalledWith({
      view: expect.objectContaining({ phase: 'unavailable' }),
    });
  });

  it('gives a pinch back when the food could not go in', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER });
    const rejected = vi.fn();
    t.events.on('feed:rejected', rejected);
    vi.spyOn(t.food, 'drop').mockReturnValue(0);
    t.controller.tap(0.1, 0.1);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(t.game.view).toMatchObject({ pinchesLeft: 5 });
  });

  it('keeps tapping outside the water from spending pinches', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER });
    t.controller.tap(3, 3);
    expect(t.game.view).toMatchObject({ pinchesLeft: 5 });
  });

  it('scores from what the fish eat and records the best when time is up', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER });
    t.events.emit('food:ate', { eaten: [{ fishId: 'f2', portion: 0.5 }] });
    for (let i = 0; i < ROUND_S * 60 + 5; i++) t.controller.update(1 / 60);
    expect(t.gameSeen).toHaveBeenLastCalledWith({
      view: expect.objectContaining({ phase: 'done', score: 50, newBest: true }),
    });
    expect(t.store.value).toBe(50);
  });

  it('stops on request', () => {
    const t = makeToyController();
    t.events.emit('game:request', { action: 'start', fish: ROSTER });
    t.events.emit('game:request', { action: 'stop' });
    expect(t.gameSeen).toHaveBeenLastCalledWith({
      view: expect.objectContaining({ phase: 'idle' }),
    });
  });

  it('clears toys and the highlight when the controller goes away', () => {
    const t = makeToyController();
    t.controller.dispose();
    expect(t.setToys).toHaveBeenLastCalledWith([]);
    expect(t.visuals.setMirror).toHaveBeenLastCalledWith(null);
    expect(t.visuals.setBall).toHaveBeenLastCalledWith(null);
    expect(t.visuals.setHighlight).toHaveBeenLastCalledWith(null);
    expect(t.nudgeBound()).toBe(false);
  });
});
