import {
  Color,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Vector2,
  Vector3,
  type Mesh,
  type Node,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  diffuseContribution,
  dot,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalWorld,
  pmremTexture,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { Bounds, WindowSlot } from '../../scene/room/layout';
import type { PracticalLight, RoomLightPlan } from '../../scene/room/roomScene';
import type { Tier } from '../quality/tiers';
import { crossfade, crossfadeAt, type Crossfade } from './crossfade';
import { roomLightAt, type Rgb, type RoomLightState } from './timeOfDay';
import { weatherAt, type Weather } from './weather';

export interface LitRoomLayout {
  readonly shell: Bounds;
  readonly tank: Bounds;
  readonly window: WindowSlot | null;
}

/** What the room needs to expose: `RoomBackdrop` and `RoomStage` satisfy it. */
export interface LitRoom {
  readonly group: Object3D;
  /** The window's sky plane; null for a room without a window. */
  readonly pane: Mesh | null;
  readonly layout: LitRoomLayout | null;
  /** Changes when meshes join the room after it was shown, such as props that finished loading. */
  readonly revision?: number;
  /**
   * The room preset's key, ambient light and lamps; without one the time of day alone lights the
   * room. Lamps may change with the revision, as when their props finish loading.
   */
  readonly rig?: RoomRig | null;
}

export type RoomRig = Pick<RoomLightPlan, 'key' | 'ambient'> & { readonly practical?: RoomLamps };

/** A room's lamps, no more than it has slots for: `roomLamps` makes one from a plan's list. */
export type RoomLamps = readonly [PracticalLight?, PracticalLight?];

/**
 * Lamps a room can light at once. Every room material carries this many lamp terms whatever the
 * room holds, so lamps coming and going change uniforms only.
 */
export const ROOM_LAMP_SLOTS: Required<RoomLamps>['length'] = 2;

/** A plan's lamps as a rig's; throws when the room plans more than it has slots for. */
export function roomLamps(practical: readonly PracticalLight[]): RoomLamps {
  if (practical.length > ROOM_LAMP_SLOTS) {
    throw new RangeError(
      `RoomLight: ${practical.length} lamps exceed ROOM_LAMP_SLOTS (${ROOM_LAMP_SLOTS}); ` +
        'plan fewer lamps for the room or raise the slots',
    );
  }
  const [first, second] = practical;
  if (!first) return [];
  return second ? [first, second] : [first];
}

export interface RoomLightDetail {
  /** Octaves of cloud noise in the window; 0 shows cover as an even overcast. */
  readonly cloudOctaves: number;
  /** Layers of falling rain streaks; 0 shows rain as haze only. */
  readonly rainLayers: number;
  /** Beads of water on the glass while it rains. */
  readonly drops: boolean;
  /** Sun through the window and the tank's glow lighting the room's surfaces. */
  readonly roomGlow: boolean;
}

export const ROOM_LIGHT_DETAIL: Readonly<Record<Tier, RoomLightDetail>> = {
  low: { cloudOctaves: 0, rainLayers: 0, drops: false, roomGlow: false },
  medium: { cloudOctaves: 2, rainLayers: 1, drops: false, roomGlow: true },
  high: { cloudOctaves: 3, rainLayers: 2, drops: false, roomGlow: true },
  ultra: { cloudOctaves: 4, rainLayers: 2, drops: true, roomGlow: true },
};

export interface RoomLightOptions {
  /** The room's PMREM (`scene.environment`), which lights the room scaled by the time of day. */
  readonly environment: Texture;
  readonly tier: Tier;
  /** The tank's seed: it picks the weather and the cloud pattern. */
  readonly seed: number;
}

export interface RoomLightInput {
  /** Epoch milliseconds: the weather and its motion follow UTC time. */
  readonly nowMs: number;
  /** Minutes after local midnight, or a pinned `?clock=`: the sun follows the wall clock. */
  readonly minute: number;
  /** The hood's level, `Engine.daylight`: 0 = moonlight only .. 1 = full day. */
  readonly hood: number;
}

/** Cloud drift in noise units per second, and the sky's pattern scale across the pane. */
const CLOUD_DRIFT = 0.004;
const CLOUD_SCALE = 2.4;
/**
 * The noise is not periodic, so clouds and beads each draw two copies cross-faded over these
 * periods (see `crossfade`): their offsets stay small for f32 and never jump on screen.
 */
const CLOUD_PERIOD_S = 2 * 3_600;
const BEAD_PERIOD_S = 4 * 60;
/** Bead slide down the pane in pane heights per second. */
const BEAD_SLIDE = 0.002;
/**
 * A copy moves to a fresh slice of noise each time it restarts, so the sky does not repeat every
 * period. Slices are a few noise cells apart, and copy B sits half way between copy A's.
 */
const LAYER_STEP = 3.1;
const LAYER_COUNT = 61;
/**
 * Fall rates in streak lengths per second, chosen so an hour holds a whole number of cycles: the
 * rain clock wraps hourly without a jump.
 */
export const RAIN_RATES = [1.25, 1.75] as const;
const SECONDS_PER_HOUR = 3_600;
/**
 * The sky and weather change on a minutes timescale, so they are recomputed once the clock has
 * moved this far. Keyed on the minute alone: a pinned `?clock=` holds the sky still, weather too.
 */
const LIGHT_STEP_MINUTES = 5 / 60;
/** Irradiance from the lit tank one metre away, under the full hood and its moonlight channel. */
const TANK_GLOW_DAY = new Color(1, 0.97, 0.92).multiplyScalar(1.4);
const TANK_GLOW_NIGHT = new Color(0.04, 0.14, 0.9).multiplyScalar(0.12);
/** Sun's apparent diameter in radians, which blurs the window's edge on the floor. */
const SUN_DIAMETER = 0.0093;
const BLACK = new Color(0, 0, 0);

/** The lit tank's glow on the room at one metre, for the hood at `hood` (0..1). */
export function tankGlow(hood: number, target = new Color()): Color {
  return target.copy(TANK_GLOW_NIGHT).lerp(TANK_GLOW_DAY, Math.min(1, Math.max(0, hood)));
}

/** One moving pattern as two cross-faded copies: offsets along the motion, noise slices, gains. */
export interface PatternMotion {
  offsetA: number;
  offsetB: number;
  layerA: number;
  layerB: number;
  gainA: number;
  gainB: number;
}

export interface WindowMotion {
  /** Cloud copies; the gains keep the blend's contrast, as the copies are independent noise. */
  readonly clouds: PatternMotion;
  /** Bead copies; the gains are plain weights, so beads fade in and out as they slide. */
  readonly beads: PatternMotion;
  /** Seconds into the UTC hour: the streaks fall a whole number of times an hour. */
  rainSeconds: number;
}

export function windowMotion(): WindowMotion {
  const pattern = (): PatternMotion => ({
    offsetA: 0,
    offsetB: 0,
    layerA: 0,
    layerB: 0,
    gainA: 0,
    gainB: 1,
  });
  return { clouds: pattern(), beads: pattern(), rainSeconds: 0 };
}

function layerOf(cycle: number): number {
  return (((cycle % LAYER_COUNT) + LAYER_COUNT) % LAYER_COUNT) * LAYER_STEP;
}

function patternAt(
  fade: Crossfade,
  periodSeconds: number,
  rate: number,
  base: number,
  keepContrast: boolean,
  out: PatternMotion,
): void {
  out.offsetA = fade.phaseA * periodSeconds * rate;
  out.offsetB = fade.phaseB * periodSeconds * rate;
  out.layerA = base + layerOf(fade.cycleA);
  out.layerB = base + layerOf(fade.cycleB) + LAYER_STEP / 2;
  const a = fade.weightA;
  const b = 1 - a;
  const norm = keepContrast ? 1 / Math.hypot(a, b) : 1;
  out.gainA = a * norm;
  out.gainB = b * norm;
}

const fadeScratch = crossfade();

/**
 * How the window's patterns have moved at epoch time `nowMs` for a tank's `seed`, written into
 * `out`. Every value is continuous in time wherever its copy's gain is above zero.
 */
export function windowMotionAt(nowMs: number, seed: number, out: WindowMotion): WindowMotion {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`windowMotionAt: time must be finite, got ${nowMs}`);
  }
  const seconds = nowMs / 1000;
  const base = cloudSeedOf(seed);
  patternAt(
    crossfadeAt(seconds, CLOUD_PERIOD_S, fadeScratch),
    CLOUD_PERIOD_S,
    CLOUD_DRIFT,
    base,
    true,
    out.clouds,
  );
  patternAt(
    crossfadeAt(seconds, BEAD_PERIOD_S, fadeScratch),
    BEAD_PERIOD_S,
    BEAD_SLIDE,
    base,
    false,
    out.beads,
  );
  out.rainSeconds = ((seconds % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) % SECONDS_PER_HOUR;
  return out;
}

function cloudSeedOf(seed: number): number {
  return (Math.abs(seed) % 997) * 0.37;
}

function setRgb(target: Color, rgb: Rgb): void {
  target.setRGB(rgb[0], rgb[1], rgb[2]);
}

/**
 * Time-of-day light and weather for the room around the tank. It paints the window's sky, scales
 * the room's environment light by the time of day and, from the medium tier up, lights the room
 * with the sun through the window and the tank's own glow. Everything moves through uniforms, so
 * only a tier change or a rebuilt room recompiles a shader.
 */
export class RoomLight {
  private readonly environment: Texture;
  private readonly seed: number;
  private tier: Tier;
  private room: LitRoom | null = null;
  private dressedLayout: LitRoomLayout | null = null;
  private dressedPane: Mesh | null = null;
  private dressedRevision = 0;
  private hasWindow = false;
  private readonly keyColour = new Color();
  private readonly ambientColour = new Color(1, 1, 1);
  private readonly dressed = new Set<MeshStandardNodeMaterial>();
  private stateNow: RoomLightState | null = null;
  private weatherNow: Weather | null = null;
  private lightAtMinute = Number.NaN;
  private readonly motion = windowMotion();
  private disposed = false;

  private readonly zenith = uniform(new Color());
  private readonly horizon = uniform(new Color());
  private readonly cloudColour = uniform(new Color());
  private readonly cloud = uniform(0);
  private readonly rain = uniform(0);
  private readonly cloudOffsetA = uniform(0);
  private readonly cloudOffsetB = uniform(0);
  private readonly cloudLayerA = uniform(0);
  private readonly cloudLayerB = uniform(0);
  private readonly cloudGainA = uniform(0);
  private readonly cloudGainB = uniform(1);
  private readonly beadOffsetA = uniform(0);
  private readonly beadOffsetB = uniform(0);
  private readonly beadLayerA = uniform(0);
  private readonly beadLayerB = uniform(0);
  private readonly beadGainA = uniform(0);
  private readonly beadGainB = uniform(1);
  private readonly rainSeconds = uniform(0);
  private readonly paneAspect = uniform(1);
  private readonly ambient = uniform(new Color(1, 1, 1));
  private readonly sunRadiance = uniform(new Color());
  private readonly toSun = uniform(new Vector3(0, 1, 0));
  private readonly windowCentre = uniform(new Vector2());
  private readonly windowHalf = uniform(new Vector2());
  private readonly wallZ = uniform(0);
  private readonly glowAt = uniform(new Vector3());
  private readonly glow = uniform(new Color());
  private readonly sunGate = uniform(0);
  private readonly envGain = uniform(new Color(1, 1, 1));
  private readonly keyAt = uniform(new Vector3());
  private readonly keyGain = uniform(new Color());
  private readonly lamps = Array.from({ length: ROOM_LAMP_SLOTS }, () => ({
    at: uniform(new Vector3()),
    gain: uniform(new Color()),
    reach: uniform(1),
  }));

  constructor(options: RoomLightOptions) {
    if (!Number.isSafeInteger(options.seed)) {
      throw new RangeError(`RoomLight: seed must be a safe integer, got ${options.seed}`);
    }
    this.environment = options.environment;
    this.seed = options.seed;
    this.tier = options.tier;
  }

  /** The light last applied, or null before the first `update`. */
  get state(): RoomLightState | null {
    return this.stateNow;
  }

  get weather(): Weather | null {
    return this.weatherNow;
  }

  get detail(): RoomLightDetail {
    return ROOM_LIGHT_DETAIL[this.tier];
  }

  /** Lamps lit in the room now, at most `ROOM_LAMP_SLOTS`. */
  get litLamps(): number {
    return this.lamps.filter((lamp) => !lamp.gain.value.equals(BLACK)).length;
  }

  /** Lights `room`, or nothing with null. Its materials are dressed again whenever it rebuilds. */
  attach(room: LitRoom | null): void {
    this.assertLive('attach');
    if (room === this.room) return;
    this.undress();
    this.room = room;
  }

  setTier(tier: Tier): void {
    this.assertLive('setTier');
    if (tier === this.tier) return;
    const before = this.detail;
    this.tier = tier;
    if (this.detail !== before) this.undress();
  }

  update(input: RoomLightInput): RoomLightState {
    this.assertLive('update');
    if (!Number.isFinite(input.hood)) {
      throw new RangeError(`RoomLight: hood level must be finite, got ${input.hood}`);
    }
    const state = this.lightAt(input.nowMs, input.minute);
    this.applyMotion(input.nowMs);
    tankGlow(input.hood, this.glow.value);
    this.dress();
    this.applyRig();
    return state;
  }

  /** Puts the room's materials back as they were built. */
  dispose(): void {
    if (this.disposed) return;
    this.undress();
    this.room = null;
    this.disposed = true;
  }

  private lightAt(nowMs: number, minute: number): RoomLightState {
    const current = this.stateNow;
    if (current && Math.abs(minute - this.lightAtMinute) < LIGHT_STEP_MINUTES) return current;
    const weather = weatherAt(nowMs, this.seed);
    const state = roomLightAt(minute, weather);
    this.weatherNow = weather;
    this.stateNow = state;
    this.lightAtMinute = minute;
    setRgb(this.zenith.value, state.zenith);
    setRgb(this.horizon.value, state.horizon);
    setRgb(this.cloudColour.value, state.cloudColour);
    setRgb(this.ambient.value, state.ambient);
    setRgb(this.sunRadiance.value, state.sunRadiance);
    const [x, y, z] = state.sun.toSun;
    this.toSun.value.set(x, y, z);
    this.cloud.value = state.cloud;
    this.rain.value = state.rain;
    return state;
  }

  private applyMotion(nowMs: number): void {
    const { clouds, beads, rainSeconds } = windowMotionAt(nowMs, this.seed, this.motion);
    this.cloudOffsetA.value = clouds.offsetA;
    this.cloudOffsetB.value = clouds.offsetB;
    this.cloudLayerA.value = clouds.layerA;
    this.cloudLayerB.value = clouds.layerB;
    this.cloudGainA.value = clouds.gainA;
    this.cloudGainB.value = clouds.gainB;
    this.beadOffsetA.value = beads.offsetA;
    this.beadOffsetB.value = beads.offsetB;
    this.beadLayerA.value = beads.layerA;
    this.beadLayerB.value = beads.layerB;
    this.beadGainA.value = beads.gainA;
    this.beadGainB.value = beads.gainB;
    this.rainSeconds.value = rainSeconds;
  }

  private assertLive(call: string): void {
    if (this.disposed) throw new Error(`RoomLight: ${call}() after dispose()`);
  }

  private dress(): void {
    const room = this.room;
    const layout = room?.layout ?? null;
    if (!room || !layout) {
      if (this.dressedLayout) this.undress();
      return;
    }
    const pane = layout.window ? room.pane : null;
    const revision = room.revision ?? 0;
    if (layout === this.dressedLayout && pane === this.dressedPane) {
      if (revision !== this.dressedRevision) {
        this.fitLamps(room);
        this.dressMaterials(room.group, revision);
      }
      return;
    }
    this.undress();
    this.fitRoom(layout, room);
    if (pane) {
      const paneMaterial = pane.material;
      if (!(paneMaterial instanceof MeshBasicNodeMaterial)) {
        throw new Error('RoomLight: the window pane needs a MeshBasicNodeMaterial');
      }
      paneMaterial.colorNode = this.skyNode();
      paneMaterial.needsUpdate = true;
    }
    this.dressedPane = pane;
    this.dressedLayout = layout;
    this.dressMaterials(room.group, revision);
  }

  private dressMaterials(group: Object3D, revision: number): void {
    this.dressedRevision = revision;
    const present = new Set<MeshStandardNodeMaterial>();
    const envNode = pmremTexture(this.environment).mul(this.envGain);
    const emissiveNode = this.detail.roomGlow ? this.roomGlowNode() : null;
    group.traverse((object) => {
      const material = (object as Partial<Mesh>).material;
      if (!(material instanceof MeshStandardNodeMaterial)) return;
      if (!material.name.startsWith('room-')) return;
      present.add(material);
      if (this.dressed.has(material)) return;
      material.envNode = envNode;
      material.emissiveNode = emissiveNode;
      material.needsUpdate = true;
      this.dressed.add(material);
    });
    for (const material of this.dressed) {
      if (!present.has(material)) this.dressed.delete(material);
    }
  }

  private applyRig(): void {
    const daylight = this.ambient.value;
    this.envGain.value.copy(this.ambientColour);
    if (this.hasWindow) this.envGain.value.multiply(daylight);
    this.keyGain.value.copy(this.keyColour);
    if (this.hasWindow) this.keyGain.value.multiply(daylight);
  }

  private undress(): void {
    const paneMaterial = this.dressedPane?.material;
    if (paneMaterial instanceof MeshBasicNodeMaterial) {
      paneMaterial.colorNode = null;
      paneMaterial.needsUpdate = true;
    }
    this.dressedPane = null;
    this.dressedLayout = null;
    this.dressedRevision = 0;
    for (const lamp of this.lamps) lamp.gain.value.setRGB(0, 0, 0);
    for (const material of this.dressed) {
      material.envNode = null;
      material.emissiveNode = null;
      material.needsUpdate = true;
    }
    this.dressed.clear();
  }

  /**
   * Places the window, the tank's glow and the preset's key in world space. A room lit by a window
   * follows the time of day; one without is lit by its own lamps at a constant level.
   */
  private fitRoom(layout: LitRoomLayout, room: LitRoom): void {
    const group = room.group;
    group.updateWorldMatrix(true, false);
    const slot = layout.window;
    this.hasWindow = slot !== null;
    this.sunGate.value = slot ? 1 : 0;
    const wall = group.localToWorld(new Vector3(0, 0, layout.shell.min[2]));
    this.wallZ.value = wall.z;
    if (slot) {
      const centre = group.localToWorld(new Vector3(...slot.centre));
      this.windowCentre.value.set(centre.x, centre.y);
      this.windowHalf.value.set(slot.size[0] / 2, slot.size[1] / 2);
      this.paneAspect.value = slot.size[0] / slot.size[1];
    }
    const rig = room.rig ?? null;
    if (rig) {
      this.keyColour.set(rig.key.color).multiplyScalar(rig.key.intensity);
      this.ambientColour.set(rig.ambient.color).multiplyScalar(rig.ambient.intensity);
      this.keyAt.value.copy(group.localToWorld(new Vector3(...rig.key.position)));
    } else {
      this.keyColour.setRGB(0, 0, 0);
      this.ambientColour.setRGB(1, 1, 1);
    }
    this.applyRig();
    this.fitLamps(room);
    const { min, max: top } = layout.tank;
    this.glowAt.value.copy(
      group.localToWorld(new Vector3((min[0] + top[0]) / 2, top[1], (min[2] + top[2]) / 2)),
    );
  }

  private fitLamps(room: LitRoom): void {
    const practical: RoomLamps = room.rig?.practical ?? [];
    this.lamps.forEach((lamp, i) => {
      const plan = practical[i];
      if (!plan) {
        lamp.gain.value.setRGB(0, 0, 0);
        return;
      }
      lamp.at.value.copy(room.group.localToWorld(new Vector3(...plan.position)));
      lamp.gain.value.set(plan.color).multiplyScalar(plan.intensity);
      lamp.reach.value = plan.distance;
    });
  }

  private skyNode(): Node<'vec3'> {
    const { cloudOctaves, rainLayers, drops } = this.detail;
    const at = uv();
    const across = vec2(at.x.mul(this.paneAspect), at.y);
    let colour: Node<'vec3'> = mix(this.horizon, this.zenith, smoothstep(0, 1, at.y));

    let cover: Node<'float'> = this.cloud;
    if (cloudOctaves > 0) {
      const p = across.mul(CLOUD_SCALE);
      const copy = (offset: Node<'float'>, layer: Node<'float'>) =>
        mx_fractal_noise_float(vec3(p.x.add(offset), p.y.mul(1.8), layer), cloudOctaves, 2, 0.5);
      const n = copy(this.cloudOffsetA, this.cloudLayerA)
        .mul(this.cloudGainA)
        .add(copy(this.cloudOffsetB, this.cloudLayerB).mul(this.cloudGainB))
        .mul(0.5)
        .add(0.5);
      const threshold = this.cloud.oneMinus().mul(0.85);
      cover = smoothstep(threshold, threshold.add(0.28), n).mul(this.cloud.mul(0.4).add(0.6));
    }
    colour = mix(colour, this.cloudColour, cover);
    colour = mix(colour, this.cloudColour.mul(0.8), this.rain.mul(0.35));

    for (let layer = 0; layer < rainLayers; layer++) {
      const rate = RAIN_RATES[layer] ?? RAIN_RATES[0];
      const columns = 70 + 45 * layer;
      const x = across.x.add(at.y.mul(0.08)).mul(columns);
      const column = floor(x);
      const lane = abs(fract(x).sub(0.5));
      const fall = fract(
        at.y
          .mul(3 + layer)
          .add(this.rainSeconds.mul(rate))
          .add(hash(column.add(layer * 31))),
      );
      const streak = smoothstep(0.7, 0.98, fall)
        .mul(smoothstep(0.04, 0.18, lane).oneMinus())
        .mul(smoothstep(0.35, 0.6, hash(column.add(17 + layer * 31))));
      colour = mix(colour, this.cloudColour.mul(1.5), streak.mul(this.rain).mul(0.45));
    }

    if (drops) {
      const copy = (offset: Node<'float'>, layer: Node<'float'>) =>
        smoothstep(
          0.06,
          0.16,
          mx_worley_noise_float(vec3(across.add(vec2(0, offset)).mul(26), layer), 1, 0),
        ).oneMinus();
      const bead = copy(this.beadOffsetA, this.beadLayerA)
        .mul(this.beadGainA)
        .add(copy(this.beadOffsetB, this.beadLayerB).mul(this.beadGainB));
      colour = mix(colour, this.horizon.mul(1.25), bead.mul(this.rain).mul(0.5));
    }
    return colour;
  }

  /**
   * Lambert light from the sun, where the ray from the surface to the sun passes through the
   * window, from the lit tank, from the preset's key, read as irradiance one metre away, and from
   * the lamps. It goes in as emission on the room's materials so the room needs no light objects,
   * which would reach every lit material in the scene, the tank's included.
   */
  private roomGlowNode(): Node<'vec3'> {
    const p = positionWorld;
    const n = normalWorld;
    const toSun = this.toSun;
    const toWall = this.wallZ.sub(p.z).div(toSun.z.min(-1e-3));
    const hit = p.xy.add(toSun.xy.mul(toWall));
    const outside = abs(hit.sub(this.windowCentre)).sub(this.windowHalf);
    const blur = toWall.mul(SUN_DIAMETER).add(0.004);
    const through = smoothstep(blur.negate(), blur, outside.x)
      .oneMinus()
      .mul(smoothstep(blur.negate(), blur, outside.y).oneMinus())
      .mul(smoothstep(this.wallZ, this.wallZ.add(0.01), p.z));
    const sun = this.sunRadiance
      .mul(max(dot(n, toSun), 0))
      .mul(through)
      .mul(this.sunGate);

    const toTank = this.glowAt.sub(p);
    const distanceSq = max(dot(toTank, toTank), float(0.3));
    const facing = max(dot(n, toTank.normalize()), 0);
    const tank = this.glow.mul(facing).div(distanceSq);

    const toKey = this.keyAt.sub(p);
    const keyFacing = max(dot(n, toKey.normalize()), 0);
    const key = this.keyGain.mul(keyFacing).div(max(dot(toKey, toKey), float(0.3)));

    let lamps: Node<'vec3'> = vec3(0);
    for (const lamp of this.lamps) {
      const toLamp = lamp.at.sub(p);
      const distance = toLamp.length();
      // three's punctual falloff with decay 2 and a cut-off, so a lamp reaches as a PointLight did.
      const falloff = distance
        .div(lamp.reach)
        .pow(4)
        .oneMinus()
        .clamp()
        .pow(2)
        .div(max(dot(toLamp, toLamp), float(0.01)));
      lamps = lamps.add(lamp.gain.mul(max(dot(n, toLamp.normalize()), 0)).mul(falloff));
    }

    return diffuseContribution.mul(sun.add(tank).add(key).add(lamps)).mul(1 / Math.PI);
  }
}
