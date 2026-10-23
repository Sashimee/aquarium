// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { Box3, Vector3 } from 'three/webgpu';
import { addDisplayControls, liveWater, WATER_SLIDER_MAX } from './devPanel';
import { DisplayPreference } from './displayPreference';
import { applyBiomeWater, BIOME_WATER } from './water/biomeWater';
import { WaterMedium } from './water/medium';

let gui: GUI | null = null;

afterEach(() => {
  gui?.destroy();
  gui = null;
});

function panel(preference: DisplayPreference) {
  gui = new GUI();
  const off = addDisplayControls(gui, preference);
  const control = (name: string) => {
    const found = gui?.controllersRecursive().find((c) => c._name === name);
    if (found === undefined) throw new Error(`no ${name} control`);
    return found;
  };
  return { off, frameRate: control('frame rate'), pixelRatio: control('pixel ratio') };
}

describe('addDisplayControls', () => {
  it('starts on the stored choice', () => {
    const preference = new DisplayPreference(null);
    preference.set({ pixelRatio: 'device' });
    const { pixelRatio } = panel(preference);
    expect(pixelRatio.getValue()).toBe('device');
  });

  it('follows a change made elsewhere, as by the settings screen', () => {
    const preference = new DisplayPreference(null);
    const { frameRate, pixelRatio } = panel(preference);
    preference.set({ frameRate: 'display' });
    expect(frameRate.getValue()).toBe('display');
    expect((frameRate.domElement.querySelector('select') as HTMLSelectElement).selectedIndex).toBe(
      1,
    );
    expect(pixelRatio.getValue()).toBe('capped');
  });

  it('writes a dropdown change to the preference', () => {
    const preference = new DisplayPreference(null);
    const { pixelRatio } = panel(preference);
    pixelRatio.setValue('device');
    expect(preference.snapshot().pixelRatio).toBe('device');
  });

  it('stops following once unsubscribed', () => {
    const preference = new DisplayPreference(null);
    const { off, frameRate } = panel(preference);
    off();
    preference.set({ frameRate: 'display' });
    expect(frameRate.getValue()).toBe('capped');
  });
});

describe('liveWater', () => {
  const tankWater = () =>
    new WaterMedium(new Box3(new Vector3(-0.5, 0, -0.2), new Vector3(0.5, 0.4, 0.2)), {
      ...BIOME_WATER.freshwater,
    });

  it('has slider room for every biome water', () => {
    for (const { cdom440, turbidity } of Object.values(BIOME_WATER)) {
      expect(cdom440).toBeLessThan(WATER_SLIDER_MAX);
      expect(turbidity).toBeLessThan(WATER_SLIDER_MAX);
    }
  });

  it('shows the water a biome switch set after the panel opened', () => {
    const medium = tankWater();
    gui = new GUI();
    const slider = gui.add(liveWater(medium), 'cdom440', 0, WATER_SLIDER_MAX, 0.01);
    applyBiomeWater(medium, 'blackwater');
    expect(slider.getValue()).toBe(BIOME_WATER.blackwater.cdom440);
  });

  it('changes only its own term and keeps the rest of the current water', () => {
    const medium = tankWater();
    const water = liveWater(medium);
    applyBiomeWater(medium, 'mangrove');
    water.cdom440 = 1.2;
    expect(medium.getQuality()).toEqual({
      cdom440: 1.2,
      turbidity: BIOME_WATER.mangrove.turbidity,
    });
    water.turbidity = 0.3;
    expect(medium.getQuality()).toEqual({ cdom440: 1.2, turbidity: 0.3 });
  });

  it('rejects negative water the way the medium does', () => {
    const water = liveWater(tankWater());
    expect(() => {
      water.turbidity = -1;
    }).toThrow(RangeError);
  });
});
