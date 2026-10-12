import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import type { Engine } from './Engine';
import { TIERS, type Tier } from './quality/tiers';

/** Developer tweak panel. Loaded only in dev builds through a dynamic import. */
export function createDevPanel(engine: Engine): () => void {
  const gui = new GUI({ title: 'Engine (dev)', width: 300 });
  gui.close();

  const readout = {
    backend: engine.backend,
    tier: engine.quality.tier as Tier,
    adaptive: engine.quality.adaptive,
    fps: '',
    frame: '',
    gpu: '',
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
  perf.add(readout, 'draws').disable().listen();
  perf.add(readout, 'triangles').disable().listen();

  const offStats = engine.events.on('engine:stats', (s) => {
    readout.tier = s.tier;
    readout.adaptive = engine.quality.adaptive;
    readout.fps = s.fps.toFixed(1);
    readout.frame = s.frameMs.toFixed(2);
    readout.gpu = s.gpuMs === null ? 'n/a' : s.gpuMs.toFixed(2);
    readout.draws = s.drawCalls;
    readout.triangles = s.triangles;
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
  lightFolder.add(scene, 'backgroundIntensity', 0, 3, 0.01).name('room background');
  lightFolder.add(renderer, 'toneMappingExposure', 0.1, 4, 0.01).name('exposure');

  return () => {
    offStats();
    gui.destroy();
  };
}
