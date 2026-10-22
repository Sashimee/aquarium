import { describe, expect, it, vi } from 'vitest';
import catalog from '../../../public/assets/index.json';
import type { Engine } from '../../engine/Engine';
import { EventBus } from '../../engine/events';
import { TANK_DIMENSIONS } from '../../engine/tank/dimensions';
import type { CatalogEntry } from '../../scene/assets';
import type { InteractionEvents } from '../events';
import { FeederLayer } from './feederLayer';
import { flat } from './fixtures';
import { createDecorSystem } from './system';
import type { DecorScenePort } from './world';

const scene: DecorScenePort = {
  biome: 'reef',
  presetHardDecor: [],
  fixedDecor: [],
  catalogEntries: () => catalog.assets as unknown as CatalogEntry[],
  groundHeight: flat,
  setHardDecor: () => Promise.resolve(),
  moveHardDecor: () => undefined,
};

const engine = {
  tank: { dimensions: TANK_DIMENSIONS.standard },
  scene: { add: () => undefined },
} as unknown as Engine;

const ray = { origin: { x: 0, y: 0.1, z: 1.6 }, dir: { x: 0, y: 0, z: -1 } };

describe('createDecorSystem coral picking', () => {
  it('answers a tap with the coral under it, or null, until it is disposed', () => {
    const bus = new EventBus<InteractionEvents>();
    const seen = vi.fn();
    bus.on('coral:picked', seen);
    const system = createDecorSystem(engine, scene, bus, null, new FeederLayer());

    bus.emit('play:tapped', { ray });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith({ key: null });

    system.dispose();
    bus.emit('play:tapped', { ray });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
