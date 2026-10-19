import { describe, expect, it } from 'vitest';
import type { TankSize } from '@aquarium/shared';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';
import { followTankSize, TankSizeSource } from './tankSize';

function loadedPayload(size: TankSize, tankId = 't1'): InteractionEvents['tank:loaded'] {
  return {
    tankId,
    biome: 'freshwater',
    size,
    fish: [],
    decorLayout: [],
    decorEdited: false,
    backgroundId: 'bg-fw-planted-stream',
  };
}

function setup(initial: TankSize = 'standard') {
  const interaction = new EventBus<InteractionEvents>();
  const source = new TankSizeSource(interaction);
  const resized: TankSize[] = [];
  const engine = {
    size: initial,
    setTankSize(size: TankSize) {
      if (size === this.size) return;
      this.size = size;
      resized.push(size);
    },
  };
  return { interaction, source, engine, resized };
}

describe('followTankSize', () => {
  it('resizes the engine to a saved tank when it loads', () => {
    const { interaction, source, engine, resized } = setup();
    followTankSize(engine, source, 'standard');
    interaction.emit('tank:loaded', loadedPayload('nano30'));
    expect(resized).toEqual(['nano30']);
  });

  it('applies a tank that loaded before the engine was up', () => {
    const { interaction, source, engine, resized } = setup();
    interaction.emit('tank:loaded', loadedPayload('long300'));
    followTankSize(engine, source, 'standard');
    expect(resized).toEqual(['long300']);
  });

  it('follows two size changes in a row, back to the demo size when no tank is left', () => {
    const { interaction, source, engine, resized } = setup('nano30');
    followTankSize(engine, source, 'nano30');
    interaction.emit('tank:loaded', loadedPayload('std200', 'a'));
    interaction.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    interaction.emit('tank:loaded', loadedPayload('long300', 'b'));
    expect(resized).toEqual(['std200', 'long300']);
    interaction.emit('tank:none', {});
    expect(resized).toEqual(['std200', 'long300', 'nano30']);
    expect(engine.size).toBe('nano30');
  });

  it('leaves the size alone between tanks of the same size and on an unload', () => {
    const { interaction, source, engine, resized } = setup();
    followTankSize(engine, source, 'standard');
    interaction.emit('tank:loaded', loadedPayload('std200', 'a'));
    interaction.emit('tank:unloaded', { tankId: 'a', reason: 'switch' });
    interaction.emit('tank:loaded', loadedPayload('std200', 'b'));
    expect(resized).toEqual(['std200']);
  });

  it('stops following', () => {
    const { interaction, source, engine, resized } = setup();
    const stop = followTankSize(engine, source, 'standard');
    stop();
    interaction.emit('tank:loaded', loadedPayload('nano30'));
    expect(resized).toEqual([]);
    source.stop();
  });
});
