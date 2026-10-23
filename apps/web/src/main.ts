import { broodTarget, followAnyFish } from './interaction/follow';
import { depthOfFieldFollowsCamera } from './engine/cameraFocus';
import type { Engine } from './engine/Engine';
import { EventBus, type EngineEvents } from './engine/events';
import { type ClockSetting } from './engine/daylight';
import type { Biome, Collider } from '@aquarium/shared';
import { colliderDigest } from './fish/simColliders';
import { queueTankEvents, startFish, type FishHandle } from './fish/start';
import { CameraRig, orbitDistanceFor, tankBounds } from './interaction/camera';
import { syncRoomLimit } from './interaction/roomLimit';
import { ShownRoom } from './interaction/shownRoom';
import { bindRoomLight } from './interaction/roomLight';
import { IdleOrbit, bindIdleInput } from './interaction/idleOrbit';
import { BackgroundChoice } from './interaction/background';
import { bindCameraControls } from './interaction/controls';
import { SceneDecor } from './interaction/decor/sceneDecor';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './interaction/events';
import { followTankSize, TankSizeSource } from './interaction/tankSize';
import { onPageTeardown } from './interaction/pageLifecycle';
import { PhotoController } from './interaction/photo/controller';
import { bindPhotoKeys } from './interaction/photo/keys';
import { watchReducedMotion } from './interaction/motion';
import { PlayChoices } from './interaction/play/choices';
import type { PlaySystem } from './interaction/play/system';
import { TankBiome } from './scene/biomeScene';
import { parseBiome, withBiome } from './scene/options';
import type { TankScene } from './scene/TankScene';
import { LoadTracker } from './ui/loadTracker';
import {
  managerOf,
  parseStallMs,
  WARMUP_FRAMES,
  watchAssets,
  watchSwitches,
  type AssetWatch,
} from './ui/loadSignals';
import { engineOptionsFor } from './ui/dayNight';
import { mountUi } from './ui/mount';
import { FeedGate } from './sync/feedGate';
import { LampFeed } from './sync/lampFeed';
import { CoralFeed } from './sync/coralFeed';
import { PlantFeed } from './sync/plantFeed';
import { RoomSeedFeed } from './sync/roomSeed';
import { bindPump, WaveMakerFeed } from './sync/waveMakerFeed';
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

  const stallMs = parseStallMs(window.location.search);
  const tracker = new LoadTracker(interaction, stallMs === undefined ? {} : { stallMs });
  tracker.begin('boot');
  const tankEvents = queueTankEvents(interaction);
  const waveMaker = new WaveMakerFeed(interaction);
  const lamp = new LampFeed(interaction);
  const plantFeed = new PlantFeed(interaction);
  const coralFeed = new CoralFeed(interaction);
  const roomSeed = new RoomSeedFeed(interaction);
  const shownRoom = new ShownRoom(interaction);
  const tankSize = new TankSizeSource(interaction);
  const tankBiome = new TankBiome(interaction, parseBiome(window.location.search));
  const switches = watchSwitches(interaction, tracker, tankBiome.fallback);
  const playChoices = new PlayChoices(interaction);
  const backgrounds = new BackgroundChoice(interaction, tankBiome.fallback);
  const sceneDecor = new SceneDecor<TankScene>(
    interaction,
    () =>
      Promise.all([import('./interaction/decor/system'), tank]).then(
        ([{ createDecorSystem }, { FeederLayer }]) =>
          (scene, initial) =>
            createDecorSystem(
              engine,
              scene,
              interaction,
              initial,
              new FeederLayer(),
              coralFeed,
              plantFeed,
            ),
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

  let pinnedClock: ClockSetting = null;
  let clockPressed = false;
  let liveEngine: Engine | null = null;
  const stopClockRequests = interaction.on('clock:request', ({ clock }) => {
    pinnedClock = clock;
    clockPressed = true;
    liveEngine?.setClock(clock);
  });
  let modules: Awaited<typeof tank>;
  let engine: Engine;
  let assetWatch: AssetWatch;
  try {
    modules = await awaitTankModules(tank, events);
    tracker.reach('code');
    const engineOptions = engineOptionsFor(window.location.search);
    if (!clockPressed) pinnedClock = engineOptions.clock;
    engine = await modules.Engine.create(container, { options: engineOptions, events });
    liveEngine = engine;
    engine.setClock(pinnedClock);
    tracker.reach('renderer');
    const { DefaultLoadingManager } = await import('three');
    assetWatch = watchAssets(
      [DefaultLoadingManager, managerOf(engine.ktx2)].filter((source) => source !== null),
      tracker,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    tracker.fail(message);
    stopClockRequests();
    switches.stop();
    waveMaker.stop();
    lamp.stop();
    plantFeed.stop();
    coralFeed.stop();
    roomSeed.stop();
    shownRoom.stop();
    tankSize.stop();
    tankEvents.stop();
    tankBiome.stop();
    stopDemoRequests();
    playChoices.stop();
    backgrounds.stop();
    sceneDecor.dispose();
    showFatal(container, message);
    return;
  }

  const { framingScale, createPlaySystem, mountBiomeScene } = modules;
  const canvas = engine.renderer.domElement;
  canvas.id = 'tank';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Aquarium view. Arrow keys orbit, plus and minus zoom, Escape leaves dive mode.',
  );

  const followFocus = depthOfFieldFollowsCamera(engine);
  const rig = new CameraRig(engine.camera, tankBounds(engine.tank.dimensions), {
    orbitDistance: orbitDistanceFor(framingScale(engine.tank.dimensions)),
    onModeChange: (mode) => {
      followFocus(mode);
      interaction.emit('camera:mode-changed', { mode });
    },
  });

  const { RoomLight } = await import('./engine/room');
  const roomLight = bindRoomLight({
    shown: shownRoom,
    room: () => engine.room,
    seed: roomSeed,
    create: (seed) => {
      const environment = engine.scene.environment;
      if (!environment) throw new Error('Room light needs the engine room environment');
      return new RoomLight({ environment, tier: engine.quality.tier, seed });
    },
    tier: () => engine.quality.tier,
    hood: () => engine.daylight,
    clock: () => engine.roomClockMinute(),
    now: () => Date.now(),
    onFrame: (callback) => engine.onFrame(callback),
  });
  const limitToRoom = (): void => syncRoomLimit(rig, engine.room?.layout ?? null);
  const showRoom = (): void => {
    void engine.setRoom(shownRoom.snapshot()).then(() => {
      roomLight.sync();
      limitToRoom();
    });
  };
  limitToRoom();
  const stopRoomLimit = [
    shownRoom.subscribe(showRoom),
    engine.events.on('engine:tank-resized', limitToRoom),
    engine.events.on('quality:tier-changed', limitToRoom),
    engine.events.on('quality:tier-changed', ({ to }) => roomLight.setTier(to)),
  ];

  const idleOrbit = new IdleOrbit(rig);
  const stopMotionWatch = watchReducedMotion((reduced) => {
    rig.setReducedMotion(reduced);
    idleOrbit.setReducedMotion(reduced);
  });
  const stopIdleInput = bindIdleInput(window, idleOrbit);
  let play: PlaySystem | null = null;
  const photo = new PhotoController({
    port: engine.photo,
    interaction,
    engineEvents: events,
    uiLayer: () => document.getElementById('photo-chrome'),
    viewHeight: () => canvas.clientHeight,
    dialogOpen: () => document.querySelector('[role="dialog"]') !== null,
  });
  const unbindPhotoKeys = bindPhotoKeys(document, photo);
  const unbindControls = bindCameraControls(canvas, rig, {
    override: () => (photo.active ? photo : null),
    tap: (e) => {
      if (e.button !== 0) return;
      if (photo.active) return photo.tap(e.x, e.y);
      if (sceneDecor.system?.active) sceneDecor.system.tap(e.x, e.y);
      else play?.controller.tap(e.x, e.y);
    },
    longPress: (e) => {
      if (e.button !== 0 || photo.active || sceneDecor.system?.active) return;
      const target = play?.controller.fishAt(e.x, e.y);
      if (target) rig.focusOn(target);
    },
    claimDrag: () =>
      sceneDecor.system?.active
        ? sceneDecor.system.claimsDrag
        : (play?.controller.claimsDrag ?? false),
    pointerDown: (x, y) =>
      photo.active
        ? undefined
        : sceneDecor.system?.active
          ? sceneDecor.system.pointerDown(x, y)
          : play?.controller.pointerDown(x, y),
    pointerMove: (x, y) =>
      photo.active
        ? undefined
        : sceneDecor.system?.active
          ? sceneDecor.system.pointerMove(x, y)
          : play?.controller.pointerMove(x, y),
    pointerUp: () =>
      sceneDecor.system?.active ? sceneDecor.system.pointerUp() : play?.controller.pointerUp(),
    pointerLeave: () => {
      if (photo.active) return;
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
  const stopFocusFish = interaction.on('camera:focus-fish', ({ fishIds }) => {
    const sim = liveFish?.sim;
    followAnyFish(
      broodTarget(fishIds, (id) => sim?.fishPoint(id)),
      (target) => rig.focusOn(target),
      interaction,
    );
  });
  const exposePose = new URLSearchParams(window.location.search).has('e2e');
  engine.onFrame((deltaS) => {
    idleOrbit.update(deltaS, photo.active || exposePose);
    rig.update(deltaS);
    photo.update(deltaS);
    if (!exposePose) return;
    const { x, y, z } = rig.lookAtPoint;
    const p = rig.position;
    const pose = [p.x, p.y, p.z, x, y, z].map((v) => v.toFixed(3)).join(' ');
    if (canvas.dataset['camera'] !== pose) canvas.dataset['camera'] = pose;
  });

  const fish = startFish(engine, {
    tank: engine.tank.dimensions,
    assetRoot: `${import.meta.env.BASE_URL}assets/`,
    biome: tankBiome.fallback,
    interaction,
    tankEvents,
  });

  liveFish = fish;
  waveMaker.attach(fish.sim);
  lamp.attach(engine);
  if (exposePose) {
    let shownSpecies: readonly string[] | null = null;
    engine.onFrame(() => {
      const species = fish.swimmingSpecies();
      if (species === shownSpecies) return;
      shownSpecies = species;
      if (species === null) delete canvas.dataset['fishSpecies'];
      else canvas.dataset['fishSpecies'] = species.join(',');
    });
    let shownColliders: readonly Collider[] | null = null;
    engine.onFrame(() => {
      const colliders = fish.simColliders();
      if (colliders === shownColliders) return;
      shownColliders = colliders;
      if (colliders === null) delete canvas.dataset['simDecor'];
      else canvas.dataset['simDecor'] = colliderDigest(colliders);
    });
  }
  const feedGate = new FeedGate();
  let firstSceneMounted = (): void => undefined;
  const sceneMounted = new Promise<void>((resolve) => {
    firstSceneMounted = resolve;
  });
  const frames = (count: number, each?: (drawn: number) => void): Promise<void> =>
    new Promise((resolve) => {
      let seen = 0;
      const stop = engine.onFrame(() => {
        seen += 1;
        each?.(seen);
        if (seen < count) return;
        stop();
        resolve();
      });
    });
  void Promise.all([fish.settled, sceneMounted]).then(() => engine.contentReady());
  void fish.settled.then(() => tracker.reach('fish'));
  void Promise.all([fish.settled, sceneMounted])
    .then(() => frames(WARMUP_FRAMES, (drawn) => tracker.part('warmup', drawn / WARMUP_FRAMES)))
    .then(() => {
      tracker.reach('warmup');
      tracker.finish();
    });
  let sceneBiome: Biome | null = null;
  let unbindPump = (): void => undefined;
  let detachCorals = (): void => undefined;
  let detachAnchors = (): void => undefined;
  let detachPlants = (): void => undefined;
  const showBackground = (state: InteractionEvents['background:state'] | undefined): void => {
    if (!state || state.biome !== sceneBiome) return;
    container.dataset['backgroundId'] = state.backgroundId ?? '';
    void engine.setBackground(state.biome, state.backgroundId);
  };
  const stopBackground = interaction.on('background:state', showBackground);
  const scenes = mountBiomeScene(engine, tankBiome, window.location.search, {
    failed: (message) => tracker.fail(message),
    mounted(scene) {
      sceneBiome = scene.biome;
      showBackground(interaction.peek('background:state'));
      void engine.useBackgroundIndex({ assets: [...scene.catalogEntries()] });
      void engine.useRoomIndex({ assets: [...scene.catalogEntries()] }).then(showRoom);
      fish.setAnchors([...scene.anchors, ...scene.banks]);
      detachAnchors = scene.onAnchorsChanged((anchors) =>
        fish.setAnchors([...anchors, ...scene.banks]),
      );
      scene.polyps.bind(fish.polyps);
      container.dataset['sceneBiome'] = scene.biome;
      scene.enableMovablePlants();
      detachPlants = plantFeed.attach(scene);
      detachCorals = coralFeed.attach(scene);
      fish.setSceneColliders(scene.colliderList);
      unbindPump = bindPump(waveMaker, engine, scene, modules.pumpFieldFor, () => fish.simTimeS());
      play = createPlaySystem(engine, scene, interaction, fish.sim, feedGate);
      playChoices.applyTo(play.controller);
      sceneDecor.mount(scene);
      tracker.reach('scene');
      firstSceneMounted();
      if (import.meta.env.DEV) Object.assign(window, { tankScene: scene });
    },
    unmounting(scene) {
      scene.polyps.dispose();
      detachPlants();
      detachPlants = () => undefined;
      detachCorals();
      detachCorals = () => undefined;
      detachAnchors();
      detachAnchors = () => undefined;
      delete container.dataset['sceneBiome'];
      delete container.dataset['backgroundId'];
      sceneBiome = null;
      sceneDecor.unmount();
      unbindPump();
      unbindPump = () => undefined;
      play?.dispose();
      play = null;
      fish.setAnchors([]);
      fish.setSceneColliders([]);
    },
  });

  const stopResize = engine.events.on('engine:tank-resized', ({ dimensions }) => {
    rig.setBounds(tankBounds(dimensions), orbitDistanceFor(framingScale(dimensions)));
    fish.setTank(dimensions);
    scenes.rebuild();
  });
  const stopTankSize = followTankSize(engine, tankSize, engine.tankSize);

  switches.attach({
    assets: assetWatch,
    sceneSettled: () => scenes.settled(),
    fishSynced: () => fish.synced(),
    frames,
  });

  onPageTeardown(window, () => {
    switches.stop();
    waveMaker.stop();
    lamp.stop();
    plantFeed.stop();
    coralFeed.stop();
    stopResize();
    for (const off of stopRoomLimit) off();
    roomLight.dispose();
    roomSeed.stop();
    shownRoom.stop();
    stopIdleInput();
    stopTankSize();
    tankSize.stop();
    assetWatch.stop();
    tracker.dispose();
    scenes.dispose().catch((cause: unknown) => console.error('Scene dispose failed', cause));
    sceneDecor.dispose();
    tankBiome.stop();
    stopDemoRequests();
    playChoices.stop();
    backgrounds.stop();
    stopBackground();
    stopMotionWatch();
    unbindControls();
    unbindPhotoKeys();
    photo.dispose();
    stopRequests();
    stopClockRequests();
    stopFocusFish();
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
