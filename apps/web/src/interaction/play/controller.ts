import type { FoodType } from '@aquarium/shared';
import type { FeedGate } from '../../sync/feedGate';
import type { EventBus } from '../../engine/events';
import type { Vec3 } from '../camera';
import { HAND_FEED_PORTION, type InteractionEvents, type PlayTool } from '../events';
import { reachableSpot, type ReachBridge } from '../food/clipReach';
import type { FoodField, FoodParticle } from '../food/particles';
import { FoodLink } from '../food/link';
import { particlesPerPortion } from '../food/profiles';
import { BubbleField } from './bubbles';
import { pickPlaneY, pickTankBox } from './pick';
import { RippleField } from './ripples';
import { TapIntensity } from './tapIntensity';
import { FeedingGame, type GameFish, type GameView } from './game';
import {
  BALL_RADIUS_M,
  mirrorMountFor,
  PingPongBall,
  type BallBounds,
  type MirrorMount,
  type SurfaceCurrent,
} from './toys';

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

export interface StimulusLike {
  readonly position: readonly [number, number, number];
  readonly intensity: number;
}

type Triple = readonly [number, number, number];

/** A toy as the sim sees it: a point of interest in its frame. */
export type SimToy =
  | {
      readonly kind: 'mirror';
      readonly id: string;
      readonly position: Triple;
      readonly normal: Triple;
    }
  | {
      readonly kind: 'ball';
      readonly id: string;
      readonly position: Triple;
      readonly velocity: Triple;
    };

type MutableMirrorToy = {
  kind: 'mirror';
  id: string;
  position: [number, number, number];
  normal: [number, number, number];
};
type MutableBallToy = {
  kind: 'ball';
  id: string;
  position: [number, number, number];
  velocity: [number, number, number];
};

const MIRROR_TOY_ID = 'mirror';
const BALL_TOY_ID = 'ball';

export interface ToyNudge {
  readonly toyId: string | null;
  /** Velocity a fish gave the ball, m/s in the sim's x and z. */
  readonly ix: number;
  readonly iz: number;
}

export interface ToyVisuals {
  setMirror(mount: MirrorMount | null): void;
  setBall(position: Vec3 | null): void;
  setHighlight(position: Vec3 | null): void;
}

export interface GameTraits {
  /** 0..1. */
  readonly boldness: number;
  readonly eatsFlakes: boolean;
  /** Top of the depth band, 0 = sand, 1 = surface. */
  readonly depthHigh: number;
}

/** Floating flakes only last a few seconds at the surface, so a fish has to live in the top of the water. */
export const GAME_MIN_DEPTH_HIGH = 0.85;

const stillWater: SurfaceCurrent = (_x, _y, _z, out) => {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
};

export interface PlayDeps {
  /** World-space ray through a canvas pixel, or null when the camera is not ready. */
  rayAt(x: number, y: number): Ray | null;
  readonly min: Vec3;
  readonly max: Vec3;
  readonly food: FoodField;
  readonly link: FoodLink;
  readonly bubbles: BubbleField;
  readonly ripples: RippleField;
  readonly gate: FeedGate;
  /** Visible substrate height at (x, z); unset means the floor is flat at the tank bottom. */
  readonly groundHeight?: ((x: number, z: number) => number) | undefined;
  readonly events: EventBus<InteractionEvents>;
  startle?: ((stimulus: StimulusLike) => void) | undefined;
  /** The swimming fish under the ray, as a position for the camera to follow. */
  pickFish?: ((ray: Ray) => (() => Vec3 | null) | null) | undefined;
  /** Picks the fish under the ray; the fish system emits `net:tap` for a catchable one. */
  netTap?: ((ray: Ray) => void) | undefined;
  toSim(x: number, y: number, z: number, out: Float64Array): void;
  lure?(position: Vec3 | null): void;
  /** Asks the sim whether a nori grazer can reach a clip; unset skips the check. */
  reach?: ReachBridge | undefined;
  setLaserDot(point: Vec3 | null): void;
  /** The surface current the ball drifts in; unset means still water. */
  current?: SurfaceCurrent | undefined;
  toyVisuals?: ToyVisuals | undefined;
  /** Gives the sim the toys as points of interest; unset until the sim has them. */
  setToys?: ((toys: readonly SimToy[]) => void) | undefined;
  /** Fish bumping the ball, from the sim; unset until the sim reports it. */
  onToyNudge?: ((listener: (nudge: ToyNudge) => void) => () => void) | undefined;
  /** Where a fish is, in scene space, for the game's highlight; unset until the sim exposes it. */
  fishPoint?: ((fishId: string) => Vec3 | null) | undefined;
  /** What the game needs to know about a species; unset or undefined rules the fish out. */
  gameTraitsOf?: ((species: string) => GameTraits | undefined) | undefined;
  game?: FeedingGame | undefined;
  report?: ((message: string, cause: unknown) => void) | undefined;
  now(): number;
}

const GLASS_OFFSET_M = 0.003;
const CLIP_CEILING_M = 0.03;
const WAND_BUBBLES_PER_S = 14;
const GRAB_RADIUS_M = BALL_RADIUS_M * 3;
const FLICK_SAMPLE_MAX_AGE_MS = 120;
const FLICK_SMOOTHING = 0.5;
const GAME_PINCH_PORTION = 0.3;
const HIGHLIGHT_LIFT_M = 0.03;

export class PlayController {
  private activeTool: PlayTool = 'tap';
  private selectedFood: FoodType = 'flakes';
  private pressed = false;
  private wandPoint: Vec3 | null = null;
  private wandCarry = 0;
  private readonly intensity = new TapIntensity();
  private readonly sim = new Float64Array(3);
  private readonly stopListening: (() => void)[];
  private ball: PingPongBall | null = null;
  private mirror: MirrorMount | null = null;
  private flick = { x: 0, z: 0, vx: 0, vz: 0, atMs: 0 };
  private ballWasMoving = false;
  private toolBeforeGame: PlayTool = 'tap';
  private readonly ballPoint: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly highlightPoint: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly simToys: (MutableMirrorToy | MutableBallToy)[] = [];
  private readonly mirrorToy: MutableMirrorToy = {
    kind: 'mirror',
    id: MIRROR_TOY_ID,
    position: [0, 0, 0],
    normal: [0, 0, 0],
  };
  private readonly ballToy: MutableBallToy = {
    kind: 'ball',
    id: BALL_TOY_ID,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
  };
  private lastToys = '';
  private lastGameKey = '';

  constructor(private readonly deps: PlayDeps) {
    this.stopListening = [
      deps.events.on('feed:select', ({ food }) => {
        this.selectedFood = food;
      }),
      deps.events.on('feed:request', ({ food, portion }) => {
        this.selectedFood = food;
        this.feed(food, portion, null);
      }),
      deps.events.on('toys:remove', ({ toy }) => this.removeToy(toy)),
      deps.events.on('game:request', (request) => {
        if (request.action === 'stop') this.stopGame();
        else this.startGame(request.fish);
      }),
      deps.events.on('food:ate', ({ eaten }) => this.publishGame(this.deps.game?.ate(eaten))),
    ];
    const stopNudge = deps.onToyNudge?.((nudge) => {
      if (nudge.toyId === BALL_TOY_ID) this.ball?.nudge(nudge.ix, nudge.iz);
    });
    if (stopNudge) this.stopListening.push(stopNudge);
    this.publishToys();
    this.publishGame(deps.game?.view, true);
  }

  get hasBall(): boolean {
    return this.ball !== null;
  }

  /** Scene-space x and z of the ball, or null without one. */
  get ballAt(): { x: number; z: number } | null {
    return this.ball ? { x: this.ball.x, z: this.ball.z } : null;
  }

  get hasMirror(): boolean {
    return this.mirror !== null;
  }

  get tool(): PlayTool {
    return this.activeTool;
  }

  /** Laser and wand own the drag so the camera does not orbit under the finger. */
  get claimsDrag(): boolean {
    return this.activeTool === 'laser' || this.activeTool === 'wand' || this.activeTool === 'ball';
  }

  setTool(tool: PlayTool): void {
    if (tool === this.activeTool) return;
    this.releaseBall();
    if (this.activeTool === 'game' && this.deps.game?.running)
      this.publishGame(this.deps.game.cancel());
    this.activeTool = tool;
    this.pressed = false;
    this.wandPoint = null;
    this.deps.setLaserDot(null);
    this.deps.lure?.(null);
    this.deps.events.emit('play:tool-changed', { tool });
  }

  tap(x: number, y: number): void {
    const ray = this.deps.rayAt(x, y);
    if (!ray) return;
    if (this.activeTool === 'feed') {
      const hit = pickPlaneY(ray.origin, ray.dir, this.deps.max.y);
      const { min, max } = this.deps;
      if (hit && hit.x >= min.x && hit.x <= max.x && hit.z >= min.z && hit.z <= max.z) {
        this.feed(this.selectedFood, HAND_FEED_PORTION, hit);
      }
      return;
    }
    if (this.activeTool === 'game') {
      this.gameTap(ray);
      return;
    }
    if (this.activeTool === 'mirror') {
      this.placeMirror(ray);
      return;
    }
    if (this.activeTool === 'net') {
      this.deps.netTap?.(ray);
      return;
    }
    if (this.activeTool === 'tap') this.tapGlass(ray);
  }

  /** The fish under a canvas point, or null; the camera follows it. */
  fishAt(x: number, y: number): (() => Vec3 | null) | null {
    const ray = this.deps.rayAt(x, y);
    return ray ? (this.deps.pickFish?.(ray) ?? null) : null;
  }

  pointerDown(x: number, y: number): void {
    this.pressed = true;
    if (this.activeTool === 'ball') this.grabBall(x, y);
    this.pointerMove(x, y);
  }

  pointerUp(): void {
    this.pressed = false;
    this.wandPoint = null;
    this.releaseBall();
  }

  pointerLeave(): void {
    this.pointerUp();
    this.hideLaser();
  }

  pointerMove(x: number, y: number): void {
    if (this.activeTool === 'ball') return this.dragBall(x, y);
    if (this.activeTool !== 'laser' && this.activeTool !== 'wand') return;
    const ray = this.deps.rayAt(x, y);
    const pick = ray ? pickTankBox(ray.origin, ray.dir, this.deps.min, this.deps.max) : null;
    const onGlass = pick !== null && pick.face !== 'top' && pick.face !== 'bottom';
    if (this.activeTool === 'laser') {
      if (!pick || !onGlass) return this.hideLaser();
      const dot = offsetInto(pick.point, pick.normal, GLASS_OFFSET_M);
      this.deps.setLaserDot(dot);
      this.deps.lure?.(dot);
      return;
    }
    this.wandPoint =
      this.pressed && pick && onGlass ? offsetInto(pick.point, pick.normal, 0.01) : null;
  }

  /** Per frame: step the particles, sync them to the sim and emit wand bubbles. */
  update(deltaS: number): void {
    const { food, link, bubbles, ripples, events } = this.deps;
    const expired = food.step(deltaS);
    if (expired.length > 0) events.emit('food:expired', { count: expired.length });
    link.update(deltaS);
    bubbles.step(deltaS);
    ripples.step(deltaS);
    this.updateToys(deltaS);
    if (this.wandPoint) {
      this.wandCarry += WAND_BUBBLES_PER_S * deltaS;
      const n = Math.floor(this.wandCarry);
      this.wandCarry -= n;
      if (n > 0) bubbles.emit(this.wandPoint.x, this.wandPoint.y, this.wandPoint.z, n);
    }
  }

  dispose(): void {
    for (const stop of this.stopListening) stop();
    this.deps.setLaserDot(null);
    this.deps.lure?.(null);
    this.deps.setToys?.([]);
    this.deps.toyVisuals?.setMirror(null);
    this.deps.toyVisuals?.setBall(null);
    this.deps.toyVisuals?.setHighlight(null);
  }

  private placeMirror(ray: Ray): void {
    const mount = mirrorMountFor(ray.origin, ray.dir, this.deps, this.deps.groundHeight);
    if (!mount) return;
    this.mirror = mount;
    this.deps.toyVisuals?.setMirror(mount);
    this.publishToys();
    this.syncSim();
  }

  /** Where a tap lands on the water surface; a tap on the glass below the surface lands above that spot. */
  private waterPoint(x: number, y: number): Vec3 | null {
    const ray = this.deps.rayAt(x, y);
    return ray ? this.surfaceUnder(ray) : null;
  }

  private surfaceUnder(ray: Ray): Vec3 | null {
    const { min, max } = this.deps;
    const top = pickPlaneY(ray.origin, ray.dir, max.y);
    if (top && top.x >= min.x && top.x <= max.x && top.z >= min.z && top.z <= max.z) return top;
    const pick = pickTankBox(ray.origin, ray.dir, min, max);
    return pick ? { x: pick.point.x, y: max.y, z: pick.point.z } : null;
  }

  private ballBounds(): BallBounds {
    const { min, max } = this.deps;
    return { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, waterTop: max.y };
  }

  private grabBall(x: number, y: number): void {
    const hit = this.waterPoint(x, y);
    if (!hit) return;
    if (!this.ball) {
      this.ball = new PingPongBall(
        this.ballBounds(),
        this.deps.current ?? stillWater,
        hit.x,
        hit.z,
      );
      this.publishToys();
      this.syncSim();
    }
    if (Math.hypot(hit.x - this.ball.x, hit.z - this.ball.z) > GRAB_RADIUS_M) return;
    this.ball.grab();
    this.flick = { x: hit.x, z: hit.z, vx: 0, vz: 0, atMs: this.deps.now() };
  }

  private dragBall(x: number, y: number): void {
    const ball = this.ball;
    if (!ball?.isHeld) return;
    const hit = this.waterPoint(x, y);
    if (!hit) return;
    const now = this.deps.now();
    const dt = (now - this.flick.atMs) / 1000;
    if (dt > 0) {
      const vx = (hit.x - this.flick.x) / dt;
      const vz = (hit.z - this.flick.z) / dt;
      this.flick.vx += (vx - this.flick.vx) * FLICK_SMOOTHING;
      this.flick.vz += (vz - this.flick.vz) * FLICK_SMOOTHING;
    }
    this.flick.x = hit.x;
    this.flick.z = hit.z;
    this.flick.atMs = now;
    ball.moveTo(hit.x, hit.z);
  }

  private releaseBall(): void {
    const ball = this.ball;
    if (!ball?.isHeld) return;
    const fresh = this.deps.now() - this.flick.atMs <= FLICK_SAMPLE_MAX_AGE_MS;
    ball.release(fresh ? this.flick.vx : 0, fresh ? this.flick.vz : 0);
  }

  private removeToy(toy: 'mirror' | 'ball'): void {
    if (toy === 'mirror') {
      this.mirror = null;
      this.deps.toyVisuals?.setMirror(null);
    } else {
      this.ball = null;
      this.deps.toyVisuals?.setBall(null);
    }
    this.publishToys();
    this.syncSim();
  }

  private publishToys(): void {
    const key = `${this.mirror !== null}|${this.ball !== null}`;
    if (key === this.lastToys) return;
    this.lastToys = key;
    this.deps.events.emit('toys:changed', {
      mirror: this.mirror !== null,
      ball: this.ball !== null,
    });
  }

  private syncSim(): void {
    if (!this.deps.setToys) return;
    const toys = this.simToys;
    toys.length = 0;
    const out = this.sim;
    if (this.mirror) {
      const { position: p, normal: n } = this.mirror;
      const toy = this.mirrorToy;
      this.deps.toSim(p.x, p.y, p.z, out);
      toy.position[0] = out[0] ?? 0;
      toy.position[1] = out[1] ?? 0;
      toy.position[2] = out[2] ?? 0;
      toy.normal[0] = n.x;
      toy.normal[1] = n.y;
      toy.normal[2] = n.z;
      toys.push(toy);
    }
    if (this.ball) {
      const toy = this.ballToy;
      this.deps.toSim(this.ball.x, this.ball.y, this.ball.z, out);
      toy.position[0] = out[0] ?? 0;
      toy.position[1] = out[1] ?? 0;
      toy.position[2] = out[2] ?? 0;
      toy.velocity[0] = this.ball.vx;
      toy.velocity[1] = 0;
      toy.velocity[2] = this.ball.vz;
      toys.push(toy);
    }
    this.deps.setToys(toys);
  }

  private updateToys(deltaS: number): void {
    const { toyVisuals, game } = this.deps;
    if (this.ball) {
      this.ball.step(deltaS);
      const point = this.ballPoint;
      point.x = this.ball.x;
      point.y = this.ball.y;
      point.z = this.ball.z;
      toyVisuals?.setBall(point);
      const moving = this.ball.isHeld || this.ball.speed > 1e-4;
      if (moving || this.ballWasMoving) this.syncSim();
      this.ballWasMoving = moving;
    }
    if (game?.running) {
      this.publishGame(game.update(deltaS));
      if (!game.running) this.leaveGame();
      const view = game.view;
      const at = view.phase === 'running' ? (this.deps.fishPoint?.(view.targetId) ?? null) : null;
      if (at) {
        const lifted = this.highlightPoint;
        lifted.x = at.x;
        lifted.y = at.y + HIGHLIGHT_LIFT_M;
        lifted.z = at.z;
        toyVisuals?.setHighlight(lifted);
      } else {
        toyVisuals?.setHighlight(null);
      }
    } else {
      toyVisuals?.setHighlight(null);
    }
  }

  private startGame(fish: readonly { id: string; name: string; species: string }[]): void {
    const game = this.deps.game;
    if (!game) return;
    const roster: GameFish[] = fish.map((f) => {
      const traits = this.deps.gameTraitsOf?.(f.species);
      return {
        id: f.id,
        name: f.name,
        boldness: traits?.boldness ?? 1,
        eligible:
          traits !== undefined && traits.eatsFlakes && traits.depthHigh >= GAME_MIN_DEPTH_HIGH,
      };
    });
    if (this.activeTool !== 'game') this.toolBeforeGame = this.activeTool;
    const view = game.start(roster);
    if (view.phase === 'running') this.setTool('game');
    this.publishGame(view);
  }

  private stopGame(): void {
    this.publishGame(this.deps.game?.cancel());
    this.leaveGame();
  }

  private leaveGame(): void {
    if (this.activeTool === 'game') this.setTool(this.toolBeforeGame);
  }

  private gameTap(ray: Ray): void {
    const game = this.deps.game;
    if (!game?.running) return;
    const hit = this.surfaceUnder(ray);
    if (!hit) return;
    if (!game.pinch()) return;
    const made = this.feed('flakes', GAME_PINCH_PORTION, hit);
    if (made === 0) game.refund();
    else game.track(this.deps.food.particles.slice(-made).map((p) => p.id));
    this.publishGame(game.view);
  }

  private publishGame(view: GameView | undefined, force = false): void {
    if (!view) return;
    const key =
      view.phase === 'running'
        ? `running|${Math.ceil(view.timeLeftS)}|${view.pinchesLeft}|${view.score}`
        : `${view.phase}|${'score' in view ? view.score : ''}|${view.best}`;
    if (!force && key === this.lastGameKey) return;
    this.lastGameKey = key;
    this.deps.events.emit('game:state', { view });
  }

  /** Drops the food and returns how many particles went in; 0 when it was refused. */
  private feed(food: FoodType, portion: number, at: Vec3 | null): number {
    const { gate, events, food: field, min, max } = this.deps;
    const fedAt = this.deps.now();
    const decision = gate.tryFeed(fedAt);
    if (!decision.ok) {
      events.emit('feed:rejected', { reason: 'rate-limited', retryAfterMs: decision.retryAfterMs });
      return 0;
    }
    const x = at ? at.x : (min.x + max.x) / 2;
    const z = at ? at.z : (min.z + max.z) / 2;
    const particles = field.drop(food, portion, x, z);
    if (particles === 0) {
      gate.release(fedAt);
      events.emit('feed:rejected', { reason: 'tank-full', retryAfterMs: 0 });
      return 0;
    }
    const placedPortion = particles / particlesPerPortion(food);
    if (food === 'nori' && this.deps.reach) {
      void this.checkClips(field.particles.slice(-particles), placedPortion, fedAt);
      return particles;
    }
    events.emit('feed:dropped', { food, portion: placedPortion, particles });
    return particles;
  }

  private async checkClips(
    clips: readonly FoodParticle[],
    portion: number,
    fedAt: number,
  ): Promise<void> {
    const { events, food: field, reach, max, gate } = this.deps;
    if (!reach) return;
    let refused = 0;
    let kept = 0;
    await Promise.all(
      clips.map(async (clip) => {
        const placed = { x: clip.x, y: clip.y, z: clip.z };
        const current = () =>
          field.particles.includes(clip) &&
          clip.x === placed.x &&
          clip.y === placed.y &&
          clip.z === placed.z;
        const spot = await reachableSpot(
          clip,
          reach,
          this.deps.toSim,
          max.y - CLIP_CEILING_M,
          current,
          this.deps.report,
        );
        if (!current()) return;
        if (spot === null) {
          field.remove([clip.id]);
          refused += 1;
        } else {
          clip.y = spot.y;
          kept += 1;
        }
      }),
    );
    if (kept > 0) {
      events.emit('feed:dropped', {
        food: 'nori',
        portion: portion * (kept / clips.length),
        particles: kept,
      });
    } else if (refused > 0) {
      gate.release(fedAt);
      events.emit('feed:rejected', { reason: 'unreachable', retryAfterMs: 0 });
    }
  }

  private tapGlass(ray: Ray): void {
    const pick = pickTankBox(ray.origin, ray.dir, this.deps.min, this.deps.max);
    if (!pick) return;
    const strength = this.intensity.next(this.deps.now());
    this.deps.ripples.add(offsetInto(pick.point, pick.normal, 0.001), pick.normal, strength);
    if (pick.face === 'top' || pick.face === 'bottom') return;
    this.deps.toSim(pick.point.x, pick.point.y, pick.point.z, this.sim);
    this.deps.startle?.({
      position: [this.sim[0] ?? 0, this.sim[1] ?? 0, this.sim[2] ?? 0],
      intensity: strength,
    });
  }

  private hideLaser(): void {
    this.deps.setLaserDot(null);
    this.deps.lure?.(null);
  }
}

function offsetInto(p: Vec3, normal: Vec3, d: number): Vec3 {
  return { x: p.x + normal.x * d, y: p.y + normal.y * d, z: p.z + normal.z * d };
}
