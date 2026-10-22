import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import {
  type DisplayPreference,
  displayPreference,
  FRAME_RATE_CHOICES,
  PIXEL_RATIO_CHOICES,
  type FrameRateChoice,
  type PixelRatioChoice,
} from './displayPreference';
import type { Engine } from './Engine';
import { TIERS, type Tier } from './quality/tiers';
import { readStats, type StatsReadout } from './statsReadout';

/**
 * Frame rate and pixel ratio dropdowns bound both ways to `preference`, so they follow a change
 * made elsewhere, such as the settings screen. Returns the unsubscribe.
 */
export function addDisplayControls(folder: GUI, preference: DisplayPreference): () => void {
  const display = { ...preference.snapshot() };
  const controls = [
    folder
      .add(display, 'frameRate', [...FRAME_RATE_CHOICES])
      .name('frame rate')
      .onChange((frameRate: FrameRateChoice) => preference.set({ frameRate })),
    folder
      .add(display, 'pixelRatio', [...PIXEL_RATIO_CHOICES])
      .name('pixel ratio')
      .onChange((pixelRatio: PixelRatioChoice) => preference.set({ pixelRatio })),
  ];
  return preference.subscribe(() => {
    Object.assign(display, preference.snapshot());
    for (const control of controls) control.updateDisplay();
  });
}

/** Developer tweak panel. Loaded only in dev builds through a dynamic import. */
export function createDevPanel(engine: Engine): () => void {
  const gui = new GUI({ title: 'Engine (dev)', width: 300 });
  gui.close();

  const readout: StatsReadout = {
    backend: engine.backend,
    tier: engine.quality.tier,
    adaptive: engine.quality.adaptive,
    fps: '',
    frame: '',
    gpu: '',
    gpuSpansFrames: false,
    dpr: '',
    pixelRatio: '',
    canvas: '',
    draws: 0,
    triangles: 0,
  };

  const perf = gui.addFolder('Performance');
  perf.add(readout, 'backend').disable();
  perf
    .add(readout, 'tier', [...TIERS])
    .onChange((tier: Tier) => engine.quality.setTier(tier, performance.now()))
    .listen();
  perf.add(readout, 'adaptive').disable().listen();
  perf.add(readout, 'fps').disable().listen();
  perf.add(readout, 'frame').name('frame ms').disable().listen();
  perf.add(readout, 'gpu').name('gpu ms').disable().listen();
  perf.add(readout, 'gpuSpansFrames').name('gpu spans frames').disable().listen();
  perf.add(readout, 'dpr').name('device px ratio').disable().listen();
  perf.add(readout, 'pixelRatio').name('render px ratio').disable().listen();
  perf.add(readout, 'canvas').disable().listen();
  perf.add(readout, 'draws').disable().listen();
  perf.add(readout, 'triangles').disable().listen();

  const offDisplay = addDisplayControls(perf, displayPreference);

  const offStats = engine.events.on('engine:stats', (s) => {
    Object.assign(readout, readStats(engine, s, window.devicePixelRatio));
  });

  const { medium, caustics, hood, scene, renderer } = engine;
  const water = { ...medium.getQuality() };
  const waterFolder = gui.addFolder('Water');
  const applyWater = (): void => medium.setQuality({ ...water });
  waterFolder.add(water, 'cdom440', 0, 2, 0.01).name('CDOM a440 (1/m)').onChange(applyWater);
  waterFolder.add(water, 'turbidity', 0, 2, 0.01).name('scattering (1/m)').onChange(applyWater);
  waterFolder.add(medium.absorptionScale, 'value', 0, 4, 0.01).name('absorption scale');
  waterFolder.addColor(engine, 'ambientScatter').name('ambient in-scatter');
  waterFolder.add(engine.tank.rippleAmplitude, 'value', 0, 1, 0.01).name('ripples');

  const causticFolder = gui.addFolder('Caustics');
  causticFolder.add(caustics.strength, 'value', 0, 1, 0.01).name('strength');
  causticFolder.add(caustics.cellsPerMetre, 'value', 2, 40, 0.5).name('cells / m');
  causticFolder.add(caustics.speed, 'value', 0, 2, 0.01).name('speed');

  const lightFolder = gui.addFolder('Light');
  lightFolder.add(hood, 'intensity', 0, 10, 0.05).name('hood intensity');
  lightFolder.addColor(hood, 'color').name('hood colour');
  lightFolder.add(scene, 'environmentIntensity', 0, 3, 0.01).name('room env');
  lightFolder.add(engine, 'roomBackgroundIntensity', 0, 3, 0.01).name('room background (day)');
  lightFolder.add(renderer, 'toneMappingExposure', 0.1, 4, 0.01).name('exposure');

  return () => {
    offStats();
    offDisplay();
    gui.destroy();
  };
}
