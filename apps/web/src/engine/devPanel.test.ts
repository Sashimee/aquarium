// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { addDisplayControls } from './devPanel';
import { DisplayPreference } from './displayPreference';

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
