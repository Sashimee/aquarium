import { followAnyFish } from './interaction/follow';
import { depthOfFieldFollowsCamera } from './engine/cameraFocus';
import type { Engine } from './engine/Engine';
import { EventBus, type EngineEvents } from './engine/events';
import { parseEngineOptions } from './engine/options';
import { queueTankEvents, startFish, type FishHandle } from './fish/start';
import { CameraRig } from './interaction/camera';
import { bindCameraControls } from './interaction/controls';
import { SceneDecor } from './interaction/decor/sceneDecor';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './interaction/events';
import { onPageTeardown } from './interaction/pageLifecycle';
import { watchReducedMotion } from './interaction/motion';
import { PlayChoices } from './interaction/play/choices';
import type { PlaySystem } from './interaction/play/system';
import { TankBiome } from './scene/biomeScene';
import { parseBiome, withBiome } from './scene/options';
import type { TankScene } from './scene/TankScene';
import { mountUi } from './ui/mount';
import { FeedGate } from './sync/feedGate';
import { awaitTankModules } from './tankLoad';

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
  const tank = import('./tank');

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
      Promise.all([import('./interaction/decor/system'), tank]).then(
        ([{ createDecorSystem }, { FeederLayer }]) =>
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

  let modules: Awaited<typeof tank>;
  let engine: Engine;
  try {
    modules = await awaitTankModules(tank, events);
    engine = await modules.Engine.create(container, {
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

  const { DEFAULT_TANK, createPlaySystem, mountBiomeScene } = modules;
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
    longPress: (e) => {
      if (e.button !== 0 || sceneDecor.system?.active) return;
      const target = play?.controller.fishAt(e.x, e.y);
      if (target) rig.focusOn(target);
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
    else {
      followAnyFish(liveFish?.sim.anyFish(), (target) => rig.focusOn(target), interaction);
    }
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
  let firstSceneMounted = (): void => undefined;
  const sceneMounted = new Promise<void>((resolve) => {
    firstSceneMounted = resolve;
  });
  void Promise.all([fish.settled, sceneMounted]).then(() => engine.contentReady());
  const scenes = mountBiomeScene(engine, tankBiome, window.location.search, {
    mounted(scene) {
      fish.setAnchors(scene.anchors);
      container.dataset['sceneBiome'] = scene.biome;
      scene.enableMovablePlants();
      fish.setSceneColliders(scene.colliderList);
      play = createPlaySystem(engine, scene, interaction, fish.sim, feedGate);
      playChoices.applyTo(play.controller);
      sceneDecor.mount(scene);
      firstSceneMounted();
      if (import.meta.env.DEV) Object.assign(window, { tankScene: scene });
    },
    unmounting() {
      delete container.dataset['sceneBiome'];
      sceneDecor.unmount();
      play?.dispose();
      play = null;
      fish.setAnchors([]);
      fish.setSceneColliders([]);
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
