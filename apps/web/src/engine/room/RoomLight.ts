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
import type { RoomLayout } from '../../scene/room/layout';
import type { Tier } from '../quality/tiers';
import { roomLightAt, type Rgb, type RoomLightState } from './timeOfDay';
import { weatherAt, type Weather } from './weather';

/** What the room needs to expose: `RoomBackdrop` satisfies it. */
export interface LitRoom {
  readonly group: Object3D;
  readonly pane: Mesh | null;
  readonly layout: RoomLayout | null;
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

/** Cloud drift in window widths per second, and the sky's pattern scale across the pane. */
const CLOUD_DRIFT = 0.004;
const CLOUD_SCALE = 2.4;
/**
 * Fall rates in streak lengths per second, chosen so an hour holds a whole number of cycles: the
 * rain clock wraps hourly without a jump.
 */
const RAIN_RATES = [1.25, 1.75] as const;
const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
/** Irradiance from the lit tank one metre away, under the full hood and its moonlight channel. */
const TANK_GLOW_DAY = new Color(1, 0.97, 0.92).multiplyScalar(1.4);
const TANK_GLOW_NIGHT = new Color(0.04, 0.14, 0.9).multiplyScalar(0.12);
/** Sun's apparent diameter in radians, which blurs the window's edge on the floor. */
const SUN_DIAMETER = 0.0093;

/** The lit tank's glow on the room at one metre, for the hood at `hood` (0..1). */
export function tankGlow(hood: number, target = new Color()): Color {
  return target.copy(TANK_GLOW_NIGHT).lerp(TANK_GLOW_DAY, Math.min(1, Math.max(0, hood)));
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
  private dressedPane: Mesh | null = null;
  private readonly dressed = new Set<MeshStandardNodeMaterial>();
  private stateNow: RoomLightState | null = null;
  private weatherNow: Weather | null = null;
  private disposed = false;

  private readonly zenith = uniform(new Color());
  private readonly horizon = uniform(new Color());
  private readonly cloudColour = uniform(new Color());
  private readonly cloud = uniform(0);
  private readonly rain = uniform(0);
  private readonly cloudSeconds = uniform(0);
  private readonly rainSeconds = uniform(0);
  private readonly paneAspect = uniform(1);
  private readonly cloudSeed = uniform(0);
  private readonly ambient = uniform(new Color(1, 1, 1));
  private readonly sunRadiance = uniform(new Color());
  private readonly toSun = uniform(new Vector3(0, 1, 0));
  private readonly windowCentre = uniform(new Vector2());
  private readonly windowHalf = uniform(new Vector2());
  private readonly wallZ = uniform(0);
  private readonly glowAt = uniform(new Vector3());
  private readonly glow = uniform(new Color());

  constructor(options: RoomLightOptions) {
    if (!Number.isSafeInteger(options.seed)) {
      throw new RangeError(`RoomLight: seed must be a safe integer, got ${options.seed}`);
    }
    this.environment = options.environment;
    this.seed = options.seed;
    this.tier = options.tier;
    this.cloudSeed.value = (Math.abs(options.seed) % 997) * 0.37;
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
    const weather = weatherAt(input.nowMs, this.seed);
    const state = roomLightAt(input.minute, weather);
    this.weatherNow = weather;
    this.stateNow = state;

    setRgb(this.zenith.value, state.zenith);
    setRgb(this.horizon.value, state.horizon);
    setRgb(this.cloudColour.value, state.cloudColour);
    setRgb(this.ambient.value, state.ambient);
    setRgb(this.sunRadiance.value, state.sunRadiance);
    this.toSun.value.set(...state.sun.toSun);
    this.cloud.value = state.cloud;
    this.rain.value = state.rain;
    const seconds = input.nowMs / 1000;
    this.cloudSeconds.value = ((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    this.rainSeconds.value = ((seconds % SECONDS_PER_HOUR) + SECONDS_PER_HOUR) % SECONDS_PER_HOUR;
    tankGlow(input.hood, this.glow.value);

    this.dress();
    return state;
  }

  /** Puts the room's materials back as they were built. */
  dispose(): void {
    if (this.disposed) return;
    this.undress();
    this.room = null;
    this.disposed = true;
  }

  private assertLive(call: string): void {
    if (this.disposed) throw new Error(`RoomLight: ${call}() after dispose()`);
  }

  private dress(): void {
    const room = this.room;
    const pane = room?.pane ?? null;
    if (!room || !room.layout || !pane) {
      if (this.dressedPane) this.undress();
      return;
    }
    if (pane === this.dressedPane) return;
    this.undress();
    this.fitWindow(room.layout, room.group);
    const paneMaterial = pane.material;
    if (!(paneMaterial instanceof MeshBasicNodeMaterial)) {
      throw new Error('RoomLight: the window pane needs a MeshBasicNodeMaterial');
    }
    paneMaterial.colorNode = this.skyNode();
    paneMaterial.needsUpdate = true;
    this.dressedPane = pane;

    const envNode = pmremTexture(this.environment).mul(this.ambient);
    const emissiveNode = this.detail.roomGlow ? this.roomGlowNode() : null;
    room.group.traverse((object) => {
      const material = (object as Partial<Mesh>).material;
      if (!(material instanceof MeshStandardNodeMaterial) || this.dressed.has(material)) return;
      if (!material.name.startsWith('room-')) return;
      material.envNode = envNode;
      material.emissiveNode = emissiveNode;
      material.needsUpdate = true;
      this.dressed.add(material);
    });
  }

  private undress(): void {
    const paneMaterial = this.dressedPane?.material;
    if (paneMaterial instanceof MeshBasicNodeMaterial) {
      paneMaterial.colorNode = null;
      paneMaterial.needsUpdate = true;
    }
    this.dressedPane = null;
    for (const material of this.dressed) {
      material.envNode = null;
      material.emissiveNode = null;
      material.needsUpdate = true;
    }
    this.dressed.clear();
  }

  private fitWindow(layout: RoomLayout, group: Object3D): void {
    group.updateWorldMatrix(true, false);
    const slot = layout.window;
    const centre = group.localToWorld(new Vector3(...slot.centre));
    const wall = group.localToWorld(new Vector3(0, 0, layout.shell.min[2]));
    this.windowCentre.value.set(centre.x, centre.y);
    this.windowHalf.value.set(slot.size[0] / 2, slot.size[1] / 2);
    this.wallZ.value = wall.z;
    this.paneAspect.value = slot.size[0] / slot.size[1];
    const { min, max: top } = layout.tank;
    this.glowAt.value.copy(
      group.localToWorld(new Vector3((min[0] + top[0]) / 2, top[1], (min[2] + top[2]) / 2)),
    );
  }

  private skyNode(): Node<'vec3'> {
    const { cloudOctaves, rainLayers, drops } = this.detail;
    const at = uv();
    const across = vec2(at.x.mul(this.paneAspect), at.y);
    let colour: Node<'vec3'> = mix(this.horizon, this.zenith, smoothstep(0, 1, at.y));

    let cover: Node<'float'> = this.cloud;
    if (cloudOctaves > 0) {
      const drift = vec2(this.cloudSeconds.mul(CLOUD_DRIFT), 0);
      const p = across.mul(CLOUD_SCALE).add(drift);
      const n = mx_fractal_noise_float(
        vec3(p.x, p.y.mul(1.8), this.cloudSeed),
        cloudOctaves,
        2,
        0.5,
      )
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
      const slide = vec2(0, this.rainSeconds.mul(0.002));
      const bead = smoothstep(
        0.06,
        0.16,
        mx_worley_noise_float(vec3(across.add(slide).mul(26), this.cloudSeed), 1, 0),
      ).oneMinus();
      colour = mix(colour, this.horizon.mul(1.25), bead.mul(this.rain).mul(0.5));
    }
    return colour;
  }

  /**
   * Lambert light from the sun, where the ray from the surface to the sun passes through the
   * window, and from the lit tank. It goes in as emission on the room's materials so the room
   * needs no light objects, which would reach every lit material in the scene.
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
    const sun = this.sunRadiance.mul(max(dot(n, toSun), 0)).mul(through);

    const toTank = this.glowAt.sub(p);
    const distanceSq = max(dot(toTank, toTank), float(0.3));
    const facing = max(dot(n, toTank.normalize()), 0);
    const tank = this.glow.mul(facing).div(distanceSq);

    return diffuseContribution.mul(sun.add(tank)).mul(1 / Math.PI);
  }
}
