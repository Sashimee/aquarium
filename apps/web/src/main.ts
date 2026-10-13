import { Engine } from './engine/Engine';
import { EventBus, type EngineEvents } from './engine/events';
import { parseEngineOptions } from './engine/options';
import { DEFAULT_TANK } from './engine/tank/dimensions';
import { queueTankEvents, startFish } from './fish/start';
import { CameraRig } from './interaction/camera';
import { bindCameraControls } from './interaction/controls';
import { FeederLayer } from './interaction/decor/feederLayer';
import type { SavedTank } from './interaction/decor/binding';
import type { DecorSystem } from './interaction/decor/system';
import type { InteractionEvents } from './interaction/events';
import { onPageTeardown } from './interaction/pageLifecycle';
import { watchReducedMotion } from './interaction/motion';
import { createPlaySystem, type PlaySystem } from './interaction/play/system';
import { mountPresetWhenTierKnown, parseBiome, type TankScene } from './scene';
import { mountUi } from './ui/mount';

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

  const events = new EventBus<EngineEvents>();
  const interaction = new EventBus<InteractionEvents>();
  events.on('engine:error', ({ message, cause }) => console.error(message, cause));
  events.on('quality:tier-changed', ({ from, to, reason }) =>
    console.info(`quality tier ${from ?? '(start)'} -> ${to} (${reason})`),
  );

  let savedTank: SavedTank | null = null;
  const watchTank = [
    interaction.on('tank:loaded', ({ tankId, biome, decorLayout }) => {
      savedTank = { tankId, biome, layout: decorLayout };
    }),
    interaction.on('tank:decor', ({ layout }) => {
      if (savedTank) savedTank = { ...savedTank, layout };
    }),
    interaction.on('tank:unloaded', () => {
      savedTank = null;
    }),
  ];

  const tankEvents = queueTankEvents(interaction);
  mountUi(uiRoot, { engine: events, interaction });

  let engine: Engine;
  try {
    engine = await Engine.create(container, {
      options: parseEngineOptions(window.location.search),
      events,
    });
  } catch (cause) {
    tankEvents.stop();
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

  const rig = new CameraRig(
    engine.camera,
    {
      halfLength: DEFAULT_TANK.length / 2,
      halfDepth: DEFAULT_TANK.depth / 2,
      height: DEFAULT_TANK.height,
      waterTop: DEFAULT_TANK.height - DEFAULT_TANK.freeboard,
      floor: DEFAULT_TANK.substrateBack + 0.05,
    },
    { onModeChange: (mode) => interaction.emit('camera:mode-changed', { mode }) },
  );

  const stopMotionWatch = watchReducedMotion((reduced) => rig.setReducedMotion(reduced));
  let play: PlaySystem | null = null;
  let decor: DecorSystem | null = null;
  const unbindControls = bindCameraControls(canvas, rig, {
    tap: (e) => {
      if (e.button !== 0) return;
      if (decor?.active) decor.tap(e.x, e.y);
      else play?.controller.tap(e.x, e.y);
    },
    claimDrag: () => (decor?.active ? decor.claimsDrag : (play?.controller.claimsDrag ?? false)),
    pointerDown: (x, y) =>
      decor?.active ? decor.pointerDown(x, y) : play?.controller.pointerDown(x, y),
    pointerMove: (x, y) =>
      decor?.active ? decor.pointerMove(x, y) : play?.controller.pointerMove(x, y),
    pointerUp: () => (decor?.active ? decor.pointerUp() : play?.controller.pointerUp()),
    pointerLeave: () => {
      if (decor?.active) decor.pointerUp();
      else play?.controller.pointerLeave();
    },
  });
  const stopRequests = interaction.on('camera:request-mode', ({ mode }) => {
    if (mode === 'dive') rig.dive();
    else if (mode === 'orbit') rig.exit();
  });
  engine.onFrame((deltaS) => rig.update(deltaS));

  const biome = parseBiome(window.location.search);
  const fish = startFish(engine, {
    tank: DEFAULT_TANK,
    assetRoot: `${import.meta.env.BASE_URL}assets/`,
    biome,
    interaction,
    tankEvents,
  });

  let tankScene: TankScene | null = null;
  let tornDown = false;
  mountPresetWhenTierKnown(engine, biome, window.location.search, (scene) => {
    tankScene = scene;
    fish.setAnchors(scene.anchors);
    play = createPlaySystem(engine, scene, interaction, fish.sim);
    import('./interaction/decor/system').then(
      ({ createDecorSystem }) => {
        if (tornDown) return;
        watchTank.forEach((off) => off());
        decor = createDecorSystem(engine, scene, interaction, savedTank, new FeederLayer());
      },
      (cause: unknown) => console.error('Decor failed to load', cause),
    );
    if (import.meta.env.DEV) Object.assign(window, { tankScene });
  });

  onPageTeardown(window, () => {
    play?.dispose();
    decor?.dispose();
    watchTank.forEach((off) => off());
    tornDown = true;
    tankScene?.dispose().catch((cause: unknown) => console.error('Scene dispose failed', cause));
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
