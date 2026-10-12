import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Engine } from './engine/Engine';
import { EventBus, type EngineEvents } from './engine/events';
import { parseEngineOptions } from './engine/options';

function showFatal(container: HTMLElement, message: string): void {
  const box = document.createElement('pre');
  box.className = 'fatal';
  box.textContent = message;
  container.replaceChildren(box);
}

async function boot(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('index.html is missing the #app element');

  const events = new EventBus<EngineEvents>();
  events.on('engine:error', ({ message, cause }) => console.error(message, cause));
  events.on('quality:tier-changed', ({ from, to, reason }) =>
    console.info(`quality tier ${from ?? '(start)'} -> ${to} (${reason})`),
  );

  let engine: Engine;
  try {
    engine = await Engine.create(container, {
      options: parseEngineOptions(window.location.search),
      events,
    });
  } catch (cause) {
    showFatal(container, cause instanceof Error ? cause.message : String(cause));
    return;
  }

  // Interim camera until the camera system (T07) replaces it.
  const controls = new OrbitControls(engine.camera, engine.renderer.domElement);
  controls.target.set(0, 0.25, 0);
  controls.enableDamping = true;
  controls.update();
  engine.onFrame(() => controls.update());

  if (import.meta.env.DEV) {
    const { createDevPanel } = await import('./engine/devPanel');
    createDevPanel(engine);
  }

  Object.assign(window, { engine });
  engine.start();
}

void boot();
