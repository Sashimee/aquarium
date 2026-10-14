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

/** What the photoperiod drives: uniforms and plain numbers only, so no shader is rebuilt. */
export interface DayLightingRig {
  readonly hood: DirectionalLight;
  readonly caustics: Caustics;
  readonly interior: InteriorLight;
  readonly medium: WaterMedium;
  readonly scene: Scene;
  readonly ambientScatter: Color;
  readonly substrateAlbedo: Color;
  /** The room backdrop's daytime level; the photoperiod scales it down at night. */
  roomBackgroundIntensity: number;
}

/**
 * The hood colour and intensity are the daytime setting (a preset may change them); `day` (0..1)
 * fades them into the moonlight channel and dims the room around the tank. The room's level is in
 * the environment node, so `scene.environmentIntensity` stays a plain gain.
 */
export function applyDayLighting(rig: DayLightingRig, day: number): void {
  const { hood, caustics, interior, medium, scene } = rig;
  caustics.setHood(hood.color, hood.intensity, MOONLIGHT, day, rig.substrateAlbedo);
  caustics.lightDirection.value.copy(hood.position).sub(hood.target.position).normalize();
  const room = ROOM_AT_NIGHT + (1 - ROOM_AT_NIGHT) * day;
  interior.roomLevel.value = room;
  scene.backgroundIntensity = rig.roomBackgroundIntensity * room;
  medium.hoodInScatter.value.copy(caustics.lightRadiance.value).multiplyScalar(1 / (4 * Math.PI));
  medium.roomInScatter.value.copy(rig.ambientScatter).multiplyScalar(room);
  interior.update();
}
