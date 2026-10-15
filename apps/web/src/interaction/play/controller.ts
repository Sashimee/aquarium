import type { FoodType } from '@aquarium/shared';
import type { FeedGate } from '../../sync/feedGate';
import type { EventBus } from '../../engine/events';
import type { Vec3 } from '../camera';
import { HAND_FEED_PORTION, type InteractionEvents, type PlayTool } from '../events';
import { FoodField } from '../food/particles';
import { FoodLink } from '../food/link';
import { BubbleField } from './bubbles';
import { pickPlaneY, pickTankBox } from './pick';
import { RippleField } from './ripples';
import { TapIntensity } from './tapIntensity';

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

export interface StimulusLike {
  readonly position: readonly [number, number, number];
  readonly intensity: number;
}

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
  readonly events: EventBus<InteractionEvents>;
  startle?: ((stimulus: StimulusLike) => void) | undefined;
  /** Picks the fish under the ray; the fish system emits `net:tap` for a catchable one. */
  netTap?: ((ray: Ray) => void) | undefined;
  toSim(x: number, y: number, z: number, out: Float64Array): void;
  lure?(position: Vec3 | null): void;
  setLaserDot(point: Vec3 | null): void;
  now(): number;
}

const GLASS_OFFSET_M = 0.003;
const WAND_BUBBLES_PER_S = 14;

export class PlayController {
  private activeTool: PlayTool = 'tap';
  private selectedFood: FoodType = 'flakes';
  private pressed = false;
  private wandPoint: Vec3 | null = null;
  private wandCarry = 0;
  private readonly intensity = new TapIntensity();
  private readonly sim = new Float64Array(3);
  private readonly stopListening: (() => void)[];

  constructor(private readonly deps: PlayDeps) {
    this.stopListening = [
      deps.events.on('feed:select', ({ food }) => {
        this.selectedFood = food;
      }),
      deps.events.on('feed:request', ({ food, portion }) => {
        this.selectedFood = food;
        this.feed(food, portion, null);
      }),
    ];
  }

  get tool(): PlayTool {
    return this.activeTool;
  }

  /** Laser and wand own the drag so the camera does not orbit under the finger. */
  get claimsDrag(): boolean {
    return this.activeTool === 'laser' || this.activeTool === 'wand';
  }

  setTool(tool: PlayTool): void {
    if (tool === this.activeTool) return;
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
    if (this.activeTool === 'net') {
      this.deps.netTap?.(ray);
      return;
    }
    if (this.activeTool === 'tap') this.tapGlass(ray);
  }

  pointerDown(x: number, y: number): void {
    this.pressed = true;
    this.pointerMove(x, y);
  }

  pointerUp(): void {
    this.pressed = false;
    this.wandPoint = null;
  }

  pointerLeave(): void {
    this.pointerUp();
    this.hideLaser();
  }

  pointerMove(x: number, y: number): void {
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
  }

  private feed(food: FoodType, portion: number, at: Vec3 | null): void {
    const { gate, events, food: field, min, max } = this.deps;
    const decision = gate.tryFeed(this.deps.now());
    if (!decision.ok) {
      events.emit('feed:rejected', { reason: 'rate-limited', retryAfterMs: decision.retryAfterMs });
      return;
    }
    const x = at ? at.x : (min.x + max.x) / 2;
    const z = at ? at.z : (min.z + max.z) / 2;
    const particles = field.drop(food, portion, x, z);
    if (particles === 0) {
      events.emit('feed:rejected', { reason: 'tank-full', retryAfterMs: 0 });
      return;
    }
    events.emit('feed:dropped', { food, portion, particles });
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
