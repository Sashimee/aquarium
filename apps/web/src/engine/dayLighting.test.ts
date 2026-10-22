import { describe, expect, it } from 'vitest';
import {
  Color,
  DirectionalLight,
  type Light,
  LightsNode,
  type Node,
  Scene,
  Texture,
} from 'three/webgpu';
import {
  applyDayLighting,
  FRESHWATER_FILL_LEVEL,
  LAMP_GAIN_MAX,
  LAMP_GAIN_MIN,
  lampGain,
  MOONLIGHT,
  type DayLightingRig,
} from './dayLighting';
import { DEFAULT_LAMP_SCHEDULE, daylightAt, parseClock } from './daylight';
import { roomDaylightAt } from './room/timeOfDay';
import { DEFAULT_TANK, waterBounds } from './tank/dimensions';
import { meanSubstrateHeight } from './tank/substrate';
import { Caustics, castingShare, causticContrast } from './water/caustics';
import { InteriorLight } from './water/interior';
import { WaterMedium } from './water/medium';

const luminance = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const at = (clock: string): number => daylightAt(parseClock(clock));

function rig(
  fillLevel = FRESHWATER_FILL_LEVEL,
  intensity = DEFAULT_LAMP_SCHEDULE.intensity,
): DayLightingRig {
  const d = DEFAULT_TANK;
  const medium = new WaterMedium(waterBounds(d), { cdom440: 0.05, turbidity: 0.08 });
  const caustics = new Caustics(medium);
  const substrateAlbedo = new Color(0.13, 0.09, 0.055);
  const interior = new InteriorLight(
    medium,
    caustics,
    new Texture(),
    substrateAlbedo,
    meanSubstrateHeight(d),
  );
  interior.fillLevel = fillLevel;
  const hood = new DirectionalLight(new Color(1, 0.97, 0.92), 4);
  hood.position.set(0.12, d.height + 1.2, 0.2);
  hood.target.position.set(0, d.height / 2, 0);
  hood.castShadow = true;
  const scene = new Scene();
  scene.add(hood, hood.target);
  scene.fogNode = medium.fogNode();
  scene.environmentNode = interior.environmentNode();
  return {
    hood,
    caustics,
    interior,
    medium,
    scene,
    ambientScatter: new Color(0.02, 0.03, 0.034),
    substrateAlbedo,
    roomBackgroundIntensity: 0.45,
    roomDaylight: 1,
    lampGain: lampGain(intensity),
  };
}

/** Everything in the scene that goes into three's per-draw pipeline key besides the material. */
function pipelineKey({ scene }: DayLightingRig): string {
  const lit: Light[] = [];
  scene.traverseVisible((object) => {
    if ((object as Light).isLight) lit.push(object as Light);
  });
  return [
    new LightsNode().setLights(lit).getCacheKey(true),
    scene.environmentNode?.getCacheKey(true),
    scene.fogNode?.getCacheKey(true),
  ].join(':');
}

function reads(node: Node | null | undefined, uniform: Node): boolean {
  let found = false;
  node?.traverse((n) => {
    if (n === uniform) found = true;
  });
  return found;
}

describe('the daytime fill', () => {
  it('is exactly zero at night, with only the moonlight on', () => {
    const r = rig();
    for (const clock of ['23:00', '00:00', '05:30', '21:00']) {
      applyDayLighting(r, at(clock));
      expect(r.interior.fill.value.toArray()).toEqual([0, 0, 0]);
      expect(luminance(r.interior.substrateBounce.value)).toBeGreaterThan(0);
    }
  });

  it('lights the water by day and follows the dawn and dusk ramps', () => {
    const r = rig();
    applyDayLighting(r, at('12:00'));
    const noon = r.interior.fill.value.clone();
    expect(luminance(noon)).toBeGreaterThan(0);
    for (const clock of ['08:20', '08:40', '20:20', '20:40']) {
      const day = at(clock);
      applyDayLighting(r, day);
      expect(day).toBeGreaterThan(0);
      expect(day).toBeLessThan(1);
      expect(r.interior.fill.value.g).toBeCloseTo(noon.g * day, 12);
    }
  });

  it('lifts the shadows from a twentieth of the direct light to about a third', () => {
    const shadowShare = (level: number): number => {
      const r = rig(level);
      applyDayLighting(r, at('12:00'));
      const depth = r.medium.boxMax.value.y - meanSubstrateHeight(DEFAULT_TANK);
      const direct = r.caustics
        .reachAtDepth(depth, new Color())
        .multiply(r.caustics.getCasting(new Color()));
      const indirect = r.interior.substrateBounce.value.clone().add(r.interior.fill.value);
      return luminance(indirect.multiplyScalar(Math.PI)) / luminance(direct);
    };
    expect(shadowShare(0)).toBeLessThan(0.06);
    expect(shadowShare(FRESHWATER_FILL_LEVEL)).toBeGreaterThan(0.28);
    expect(shadowShare(FRESHWATER_FILL_LEVEL)).toBeLessThan(0.38);
  });

  it('reaches the shaders through the environment, as a uniform', () => {
    const r = rig();
    expect(reads(r.scene.environmentNode, r.interior.fill)).toBe(true);
    expect(reads(r.interior.ambientAt(r.medium.boxMax, r.medium.boxMax), r.interior.fill)).toBe(
      true,
    );
  });

  it('never counts toward the share of the hood light that casts caustics', () => {
    for (const clock of ['12:00', '08:30', '20:30', '20:55']) {
      const withFill = rig(FRESHWATER_FILL_LEVEL);
      const without = rig(0);
      applyDayLighting(withFill, at(clock));
      applyDayLighting(without, at(clock));
      const { caustics } = withFill;
      expect(luminance(withFill.interior.fill.value)).toBeGreaterThan(0);
      expect(caustics.lightRadiance.value.equals(without.caustics.lightRadiance.value)).toBe(true);
      expect(caustics.contrast.value).toBe(without.caustics.contrast.value);
      expect(caustics.shaftContrast.value).toBe(without.caustics.shaftContrast.value);

      const main = withFill.hood.color.clone().multiplyScalar(withFill.hood.intensity * at(clock));
      const all = MOONLIGHT.clone()
        .multiplyScalar(1 - at(clock))
        .add(main);
      const share = castingShare(luminance(main), luminance(all));
      expect(caustics.contrast.value).toBeCloseTo(
        causticContrast(caustics.strength.value, share, luminance(withFill.substrateAlbedo)),
        12,
      );
    }
  });

  it('changes only uniforms over a whole day, so no pipeline is rebuilt', () => {
    const r = rig();
    const { environmentNode, fogNode } = r.scene;
    applyDayLighting(r, at('12:00'));
    const key = pipelineKey(r);
    const fills = new Set<string>();
    for (let minute = 0; minute < 24 * 60; minute += 10) {
      applyDayLighting(r, daylightAt(minute));
      expect(pipelineKey(r)).toBe(key);
      fills.add(r.interior.fill.value.getHexString());
    }
    expect(r.scene.environmentNode).toBe(environmentNode);
    expect(r.scene.fogNode).toBe(fogNode);
    expect(fills.size).toBeGreaterThan(2);
  });
});

describe('lampGain', () => {
  it('spans two stops under the tuned level to half a stop over, with the default at it', () => {
    expect(lampGain(0)).toBeCloseTo(LAMP_GAIN_MIN, 12);
    expect(lampGain(1)).toBeCloseTo(LAMP_GAIN_MAX, 12);
    expect(Math.log2(LAMP_GAIN_MIN)).toBeCloseTo(-2, 12);
    expect(Math.log2(LAMP_GAIN_MAX)).toBeCloseTo(0.5, 12);
    expect(lampGain(DEFAULT_LAMP_SCHEDULE.intensity)).toBeCloseTo(1, 12);
  });

  it('rises with every step of the slider', () => {
    for (let step = 1; step <= 100; step++) {
      expect(lampGain(step / 100)).toBeGreaterThan(lampGain((step - 1) / 100));
    }
  });

  it('refuses a setting outside 0..1', () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => lampGain(bad)).toThrow(RangeError);
    }
  });
});

describe('the lamp strength', () => {
  const noonLight = (intensity: number): number => {
    const r = rig(FRESHWATER_FILL_LEVEL, intensity);
    applyDayLighting(r, at('12:00'));
    return luminance(r.caustics.lightRadiance.value);
  };

  it('brightens the hood light, its caustics and in-scatter as it rises', () => {
    let previous = { light: 0, inScatter: 0, fill: 0 };
    for (const intensity of [0, 0.25, 0.5, 0.8, 0.9, 1]) {
      const r = rig(FRESHWATER_FILL_LEVEL, intensity);
      applyDayLighting(r, at('12:00'));
      const now = {
        light: luminance(r.caustics.lightRadiance.value),
        inScatter: luminance(r.medium.hoodInScatter.value),
        fill: luminance(r.interior.fill.value),
      };
      expect(now.light).toBeGreaterThan(previous.light);
      expect(now.inScatter).toBeGreaterThan(previous.inScatter);
      expect(now.fill).toBeGreaterThan(previous.fill);
      previous = now;
    }
  });

  it('keeps the dimmest lamp well above the moonlight and the brightest within half a stop', () => {
    const tuned = noonLight(DEFAULT_LAMP_SCHEDULE.intensity);
    const night = rig();
    applyDayLighting(night, 0);
    const moonlight = luminance(night.caustics.lightRadiance.value);
    expect(noonLight(0)).toBeCloseTo(tuned * LAMP_GAIN_MIN, 9);
    expect(noonLight(0)).toBeGreaterThan(5 * moonlight);
    expect(noonLight(1)).toBeCloseTo(tuned * LAMP_GAIN_MAX, 9);
  });

  it('leaves the moonlight alone', () => {
    const dim = rig(FRESHWATER_FILL_LEVEL, 0);
    const bright = rig(FRESHWATER_FILL_LEVEL, 1);
    applyDayLighting(dim, 0);
    applyDayLighting(bright, 0);
    expect(dim.caustics.lightRadiance.value.equals(bright.caustics.lightRadiance.value)).toBe(true);
  });

  it('scales the dawn and dusk ramps without changing their shape', () => {
    for (const intensity of [0, 0.5, 1]) {
      const r = rig(FRESHWATER_FILL_LEVEL, intensity);
      applyDayLighting(r, at('12:00'));
      const noon = r.caustics.getCasting(new Color());
      for (const clock of ['08:10', '08:30', '08:50', '20:10', '20:30', '20:50']) {
        applyDayLighting(r, at(clock));
        const casting = r.caustics.getCasting(new Color());
        expect(casting.g / noon.g).toBeCloseTo(at(clock), 12);
      }
    }
  });
});

describe('the room backdrop', () => {
  it('keeps a changed daytime level through every later frame and scales it at night', () => {
    const r = rig();
    r.roomBackgroundIntensity = 1.2;
    applyDayLighting(r, at('12:00'));
    applyDayLighting(r, at('12:00'));
    expect(r.scene.backgroundIntensity).toBeCloseTo(1.2);
    r.roomDaylight = roomDaylightAt(parseClock('02:00'));
    applyDayLighting(r, at('12:00'));
    expect(r.scene.backgroundIntensity).toBeGreaterThan(0);
    expect(r.scene.backgroundIntensity).toBeLessThan(0.3);
  });

  it("follows the room's daylight, not the hood's lamp schedule", () => {
    const morning = rig();
    morning.roomDaylight = roomDaylightAt(parseClock('09:00'));
    applyDayLighting(morning, 0);
    const evening = rig();
    evening.roomDaylight = roomDaylightAt(parseClock('23:00'));
    applyDayLighting(evening, 1);
    expect(morning.interior.roomLevel.value).toBeGreaterThan(0.8);
    expect(evening.interior.roomLevel.value).toBeLessThan(0.2);
    expect(morning.scene.backgroundIntensity).toBeGreaterThan(evening.scene.backgroundIntensity);
    expect(morning.medium.roomInScatter.value.g).toBeGreaterThan(
      evening.medium.roomInScatter.value.g,
    );
    evening.roomDaylight = 0;
    applyDayLighting(evening, 1);
    const night = evening.interior.roomLevel.value;
    expect(night).toBeGreaterThan(0);
    evening.roomDaylight = -3;
    applyDayLighting(evening, 1);
    expect(evening.interior.roomLevel.value).toBe(night);
  });

  it('goes dark when the daytime level is zero', () => {
    const r = rig();
    r.roomBackgroundIntensity = 0;
    applyDayLighting(r, at('12:00'));
    expect(r.scene.backgroundIntensity).toBe(0);
  });
});

describe('InteriorLight.fillLevel', () => {
  it('refuses a negative or non-finite share', () => {
    const { interior } = rig();
    expect(() => (interior.fillLevel = -0.1)).toThrow(RangeError);
    expect(() => (interior.fillLevel = Number.NaN)).toThrow(RangeError);
    expect(() => (interior.fillLevel = Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(interior.fillLevel).toBe(FRESHWATER_FILL_LEVEL);
  });

  it('leaves the fill off at zero, as on the reef', () => {
    const r = rig(0);
    applyDayLighting(r, at('12:00'));
    expect(r.interior.fill.value.toArray()).toEqual([0, 0, 0]);
  });
});
