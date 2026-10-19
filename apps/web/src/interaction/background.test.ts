import { BACKGROUND_IDS, DEFAULT_BACKGROUND_ID, type Biome } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import { BackgroundChoice, shownBackground } from './background';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './events';

function setup(demo: Biome = 'freshwater') {
  const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
  const saves: InteractionEvents['background:save'][] = [];
  bus.on('background:save', (e) => saves.push(e));
  const choice = new BackgroundChoice(bus, demo);
  const state = () => bus.peek('background:state');
  const load = (
    tankId: string,
    biome: Biome,
    backgroundId: InteractionEvents['tank:loaded']['backgroundId'],
  ) =>
    bus.emit('tank:loaded', {
      tankId,
      biome,
      fish: [],
      decorLayout: [],
      decorEdited: false,
      backgroundId,
    });
  return { bus, choice, saves, state, load };
}

describe('shownBackground', () => {
  it('keeps a pick that belongs to the biome and defaults otherwise', () => {
    expect(shownBackground('reef', BACKGROUND_IDS.reef[2])).toBe(BACKGROUND_IDS.reef[2]);
    expect(shownBackground('reef', BACKGROUND_IDS.freshwater[2])).toBe(DEFAULT_BACKGROUND_ID.reef);
    expect(shownBackground('freshwater', null)).toBe(DEFAULT_BACKGROUND_ID.freshwater);
  });
});

describe('BackgroundChoice', () => {
  it('starts on the demo biome default', () => {
    expect(setup('reef').state()).toEqual({
      tankId: null,
      biome: 'reef',
      backgroundId: DEFAULT_BACKGROUND_ID.reef,
    });
  });

  it('previews a pick on the demo tank without asking to save it', () => {
    const { bus, state, saves } = setup();
    bus.emit('background:choose', { backgroundId: BACKGROUND_IDS.freshwater[3] });
    expect(state()?.backgroundId).toBe(BACKGROUND_IDS.freshwater[3]);
    expect(saves).toEqual([]);
  });

  it('shows a saved tank background and asks to save a new pick once', () => {
    const { bus, state, saves, load } = setup();
    load('t1', 'reef', BACKGROUND_IDS.reef[1]);
    expect(state()).toEqual({ tankId: 't1', biome: 'reef', backgroundId: BACKGROUND_IDS.reef[1] });
    bus.emit('background:choose', { backgroundId: BACKGROUND_IDS.reef[4] });
    bus.emit('background:choose', { backgroundId: BACKGROUND_IDS.reef[4] });
    expect(saves).toEqual([{ tankId: 't1', backgroundId: BACKGROUND_IDS.reef[4] }]);
  });

  it('ignores a pick from the other biome', () => {
    const { bus, state, saves, load } = setup();
    load('t1', 'reef', BACKGROUND_IDS.reef[1]);
    bus.emit('background:choose', { backgroundId: BACKGROUND_IDS.freshwater[0] });
    expect(state()?.backgroundId).toBe(BACKGROUND_IDS.reef[1]);
    expect(saves).toEqual([]);
  });

  it('follows the server for the shown tank only', () => {
    const { bus, state, load } = setup();
    load('t1', 'freshwater', BACKGROUND_IDS.freshwater[0]);
    bus.emit('tank:background', { tankId: 'other', backgroundId: BACKGROUND_IDS.freshwater[4] });
    expect(state()?.backgroundId).toBe(BACKGROUND_IDS.freshwater[0]);
    bus.emit('tank:background', { tankId: 't1', backgroundId: BACKGROUND_IDS.freshwater[4] });
    expect(state()?.backgroundId).toBe(BACKGROUND_IDS.freshwater[4]);
  });

  it('returns to the demo tank, in the demo biome, when no saved tank is left', () => {
    const { bus, state, load } = setup();
    load('t1', 'freshwater', BACKGROUND_IDS.freshwater[1]);
    bus.emit('demo:biome-changed', { biome: 'reef' });
    expect(state()?.tankId).toBe('t1');
    bus.emit('tank:none', {});
    expect(state()).toEqual({
      tankId: null,
      biome: 'reef',
      backgroundId: DEFAULT_BACKGROUND_ID.reef,
    });
  });

  it('stops listening once stopped', () => {
    const { bus, choice, state } = setup();
    choice.stop();
    bus.emit('background:choose', { backgroundId: BACKGROUND_IDS.freshwater[2] });
    expect(state()?.backgroundId).toBe(DEFAULT_BACKGROUND_ID.freshwater);
  });
});
