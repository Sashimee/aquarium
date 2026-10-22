import { Color, type DirectionalLight, type Scene } from 'three/webgpu';
import type { Caustics } from './water/caustics';
import type { InteriorLight } from './water/interior';
import type { WaterMedium } from './water/medium';

/** The hood's blue "moonlight" channel, left on through the night. */
export const MOONLIGHT = new Color(0.04, 0.14, 0.9);
/** Room light at night relative to the day, from a lamp somewhere in the room. */
const ROOM_AT_NIGHT = 0.15;
/**
 * The freshwater fill (see `InteriorLight.fill`). The dark sand throws back only a twentieth of the
 * hood's light at the floor into the shadows; this brings them to about a third, as the reef's
 * bright sand does on its own.
 */
export const FRESHWATER_FILL_LEVEL = 0.28;

/**
 * The hood's light at the lamp's lowest and highest strength setting. The scale is in stops, as a
 * dimmer is seen: two stops down still lights the tank clearly over the moonlight, and half a stop
 * up stays within what AgX at exposure 1 rolls off on white sand. The default setting, 0.8, lands
 * on exactly 1, the level the scene is tuned at.
 */
const LAMP_STOPS_MIN = -2;
const LAMP_STOPS_MAX = 0.5;
const LAMP_STOPS_SPAN = LAMP_STOPS_MAX - LAMP_STOPS_MIN;
// Subtracting this setting rather than adding stops to LAMP_STOPS_MIN gives an exact 0 at 0.8.
const LAMP_TUNED_SETTING = -LAMP_STOPS_MIN / LAMP_STOPS_SPAN;
export const LAMP_GAIN_MIN = 2 ** LAMP_STOPS_MIN;
export const LAMP_GAIN_MAX = 2 ** LAMP_STOPS_MAX;

/** The hood's light relative to the tuned level for a lamp strength setting, 0..1. */
export function lampGain(intensity: number): number {
  if (!(intensity >= 0 && intensity <= 1)) {
    throw new RangeError(`lampGain: lamp intensity must be within 0..1, got ${intensity}`);
  }
  return 2 ** (LAMP_STOPS_SPAN * (intensity - LAMP_TUNED_SETTING));
}

/** What the photoperiod drives: uniforms and plain numbers only, so no shader is rebuilt. */
export interface DayLightingRig {
  readonly hood: DirectionalLight;
  readonly caustics: Caustics;
  readonly interior: InteriorLight;
  readonly medium: WaterMedium;
  readonly scene: Scene;
  readonly ambientScatter: Color;
  readonly substrateAlbedo: Color;
  /** The room backdrop's daytime level; the room's daylight scales it down at night. */
  roomBackgroundIntensity: number;
  /**
   * Daylight in the room on the wall clock (`roomDaylightAt`), 0 = night .. 1 = midday. The hood
   * runs on the lamp schedule instead, so the two are set apart.
   */
  roomDaylight: number;
  /** The lamp's strength setting as a gain on the hood's main channel (`lampGain`). */
  lampGain: number;
}

/**
 * The hood colour and intensity are the daytime setting (a preset may change them); `day` (0..1)
 * fades them into the moonlight channel, and `rig.lampGain` scales the main channel only.
 * `rig.roomDaylight` dims the room around the tank. The room's level is in the environment node,
 * so `scene.environmentIntensity` stays a plain gain.
 */
export function applyDayLighting(rig: DayLightingRig, day: number): void {
  const { hood, caustics, interior, medium, scene } = rig;
  caustics.setHood(hood.color, hood.intensity * rig.lampGain, MOONLIGHT, day, rig.substrateAlbedo);
  caustics.lightDirection.value.copy(hood.position).sub(hood.target.position).normalize();
  const outside = Math.min(1, Math.max(0, rig.roomDaylight));
  const room = ROOM_AT_NIGHT + (1 - ROOM_AT_NIGHT) * outside;
  interior.roomLevel.value = room;
  scene.backgroundIntensity = rig.roomBackgroundIntensity * room;
  medium.hoodInScatter.value.copy(caustics.lightRadiance.value).multiplyScalar(1 / (4 * Math.PI));
  medium.roomInScatter.value.copy(rig.ambientScatter).multiplyScalar(room);
  interior.update();
}
