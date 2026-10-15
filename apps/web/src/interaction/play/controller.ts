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
  /** The swimming fish under the ray, as a position for the camera to follow. */
  pickFish?: ((ray: Ray) => (() => Vec3 | null) | null) | undefined;
  /** Picks the fish under the ray; the fish system emits `net:tap` for a catchable one. */
  netTap?: ((ray: Ray) => void) | undefined;
  toSim(x: number, y: number, z: number, out: Float64Array): void;
  lure?(position: Vec3 | null): void;
  /** Asks the sim whether a nori grazer can reach a clip; unset skips the check. */
  reach?: ReachBridge | undefined;
  setLaserDot(point: Vec3 | null): void;
  report?: ((message: string, cause: unknown) => void) | undefined;
  now(): number;
}

const GLASS_OFFSET_M = 0.003;
const CLIP_CEILING_M = 0.03;
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

  /** The fish under a canvas point, or null; the camera follows it. */
  fishAt(x: number, y: number): (() => Vec3 | null) | null {
    const ray = this.deps.rayAt(x, y);
    return ray ? (this.deps.pickFish?.(ray) ?? null) : null;
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
    this.deps.lure?.(null);
  }

  private feed(food: FoodType, portion: number, at: Vec3 | null): void {
    const { gate, events, food: field, min, max } = this.deps;
    const fedAt = this.deps.now();
    const decision = gate.tryFeed(fedAt);
    if (!decision.ok) {
      events.emit('feed:rejected', { reason: 'rate-limited', retryAfterMs: decision.retryAfterMs });
      return;
    }
    const x = at ? at.x : (min.x + max.x) / 2;
    const z = at ? at.z : (min.z + max.z) / 2;
    const particles = field.drop(food, portion, x, z);
    if (particles === 0) {
      gate.release(fedAt);
      events.emit('feed:rejected', { reason: 'tank-full', retryAfterMs: 0 });
      return;
    }
    const wanted = Math.max(1, Math.round(particlesPerPortion(food) * portion));
    const placedPortion = portion * Math.min(1, particles / wanted);
    if (food === 'nori' && this.deps.reach) {
      void this.checkClips(field.particles.slice(-particles), placedPortion, fedAt);
      return;
    }
    events.emit('feed:dropped', { food, portion: placedPortion, particles });
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
