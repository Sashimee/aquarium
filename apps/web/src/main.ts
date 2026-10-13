import { depthOfFieldFollowsCamera } from './engine/cameraFocus';
import { Engine } from './engine/Engine';
import { EventBus, type EngineEvents } from './engine/events';
import { parseEngineOptions } from './engine/options';
import { DEFAULT_TANK } from './engine/tank/dimensions';
import { queueTankEvents, startFish, type FishHandle } from './fish/start';
import { CameraRig } from './interaction/camera';
import { bindCameraControls } from './interaction/controls';
import { FeederLayer } from './interaction/decor/feederLayer';
import { SceneDecor } from './interaction/decor/sceneDecor';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './interaction/events';
import { onPageTeardown } from './interaction/pageLifecycle';
import { watchReducedMotion } from './interaction/motion';
import { PlayChoices } from './interaction/play/choices';
import { createPlaySystem, type PlaySystem } from './interaction/play/system';
import { mountBiomeScene, parseBiome, TankBiome, withBiome, type TankScene } from './scene';
import { mountUi } from './ui/mount';
import { FeedGate } from './sync/feedGate';

function showFatal(container: HTMLElement, message: string): void {
  const box = document.createElement('pre');
  box.className = 'fatal';
  box.setAttribute('role', 'alert');
  box.textContent = message;
  container.replaceChildren(box);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html is missing the #${id} element`);
  return element;
}

async function boot(): Promise<void> {
  const container = requireElement('app');
  const uiRoot = requireElement('ui');

  const events = new EventBus<EngineEvents>(undefined, ['engine:ready']);
  const interaction = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
  events.on('engine:error', ({ message, cause }) => console.error(message, cause));
  events.on('quality:tier-changed', ({ from, to, reason }) =>
    console.info(`quality tier ${from ?? '(start)'} -> ${to} (${reason})`),
  );

  const tankEvents = queueTankEvents(interaction);
  const tankBiome = new TankBiome(interaction, parseBiome(window.location.search));
  const playChoices = new PlayChoices(interaction);
  const sceneDecor = new SceneDecor<TankScene>(
    interaction,
    () =>
      import('./interaction/decor/system').then(
        ({ createDecorSystem }) =>
          (scene, initial) =>
            createDecorSystem(engine, scene, interaction, initial, new FeederLayer()),
      ),
    (message, cause) => console.error(message, cause),
  );
  let liveFish: FishHandle | null = null;
  const stopDemoRequests = interaction.on('demo:request-biome', ({ biome }) => {
    if (biome === tankBiome.fallback) return;
    tankBiome.setFallback(biome);
    liveFish?.setDemoBiome(biome);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${withBiome(search, biome)}${hash}`,
    );
    interaction.emit('demo:biome-changed', { biome });
  });
  mountUi(uiRoot, { engine: events, interaction });

  let engine: Engine;
  try {
    engine = await Engine.create(container, {
      options: parseEngineOptions(window.location.search),
      events,
    });
  } catch (cause) {
    tankEvents.stop();
    tankBiome.stop();
    stopDemoRequests();
    playChoices.stop();
    sceneDecor.dispose();
    showFatal(container, cause instanceof Error ? cause.message : String(cause));
    return;
  }

  const canvas = engine.renderer.domElement;
  canvas.id = 'tank';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Aquarium view. Arrow keys orbit, plus and minus zoom, Escape leaves dive mode.',
  );

  const followFocus = depthOfFieldFollowsCamera(engine);
  const rig = new CameraRig(
    engine.camera,
    {
      halfLength: DEFAULT_TANK.length / 2,
      halfDepth: DEFAULT_TANK.depth / 2,
      height: DEFAULT_TANK.height,
      waterTop: DEFAULT_TANK.height - DEFAULT_TANK.freeboard,
      floor: DEFAULT_TANK.substrateBack + 0.05,
    },
    {
      onModeChange: (mode) => {
        followFocus(mode);
        interaction.emit('camera:mode-changed', { mode });
      },
    },
  );

  const stopMotionWatch = watchReducedMotion((reduced) => rig.setReducedMotion(reduced));
  let play: PlaySystem | null = null;
  const unbindControls = bindCameraControls(canvas, rig, {
    tap: (e) => {
      if (e.button !== 0) return;
      if (sceneDecor.system?.active) sceneDecor.system.tap(e.x, e.y);
      else play?.controller.tap(e.x, e.y);
    },
    claimDrag: () =>
      sceneDecor.system?.active
        ? sceneDecor.system.claimsDrag
        : (play?.controller.claimsDrag ?? false),
    pointerDown: (x, y) =>
      sceneDecor.system?.active
        ? sceneDecor.system.pointerDown(x, y)
        : play?.controller.pointerDown(x, y),
    pointerMove: (x, y) =>
      sceneDecor.system?.active
        ? sceneDecor.system.pointerMove(x, y)
        : play?.controller.pointerMove(x, y),
    pointerUp: () =>
      sceneDecor.system?.active ? sceneDecor.system.pointerUp() : play?.controller.pointerUp(),
    pointerLeave: () => {
      if (sceneDecor.system?.active) sceneDecor.system.pointerUp();
      else play?.controller.pointerLeave();
    },
  });
  const stopRequests = interaction.on('camera:request-mode', ({ mode }) => {
    if (mode === 'dive') rig.dive();
    else if (mode === 'orbit') rig.exit();
  });
  const exposePose = new URLSearchParams(window.location.search).has('e2e');
  engine.onFrame((deltaS) => {
    rig.update(deltaS);
    if (!exposePose) return;
    const { x, y, z } = rig.lookAtPoint;
    const p = rig.position;
    const pose = [p.x, p.y, p.z, x, y, z].map((v) => v.toFixed(3)).join(' ');
    if (canvas.dataset['camera'] !== pose) canvas.dataset['camera'] = pose;
  });

  const fish = startFish(engine, {
    tank: DEFAULT_TANK,
    assetRoot: `${import.meta.env.BASE_URL}assets/`,
    biome: tankBiome.fallback,
    interaction,
    tankEvents,
  });

  liveFish = fish;
  const feedGate = new FeedGate();
  const scenes = mountBiomeScene(engine, tankBiome, window.location.search, {
    mounted(scene) {
      fish.setAnchors(scene.anchors);
      play = createPlaySystem(engine, scene, interaction, fish.sim, feedGate);
      playChoices.applyTo(play.controller);
      sceneDecor.mount(scene);
      if (import.meta.env.DEV) Object.assign(window, { tankScene: scene });
    },
    unmounting() {
      sceneDecor.unmount();
      play?.dispose();
      play = null;
      fish.setAnchors([]);
    },
  });

  onPageTeardown(window, () => {
    scenes.dispose().catch((cause: unknown) => console.error('Scene dispose failed', cause));
    sceneDecor.dispose();
    tankBiome.stop();
    stopDemoRequests();
    playChoices.stop();
    stopMotionWatch();
    unbindControls();
    stopRequests();
    fish.stop();
    engine.dispose().catch((cause: unknown) => console.error('Engine dispose failed', cause));
  });

  if (import.meta.env.DEV) {
    const { createDevPanel } = await import('./engine/devPanel');
    createDevPanel(engine);
    Object.assign(window, { engine });
  }

  engine.start();
}

void boot();
