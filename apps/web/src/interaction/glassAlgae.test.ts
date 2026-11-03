import { describe, expect, it } from 'vitest';
import type { Water } from '@aquarium/shared';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from './events';
import { followGlassAlgae, GlassAlgaeSource, glassAlgaeAmount } from './glassAlgae';

function water(algae: number): Water {
  return { ammonia: 0, nitrate: 0, algae, tannin: 0, uneatenFood: 0 };
}

function setup() {
  const interaction = new EventBus<InteractionEvents>();
  const source = new GlassAlgaeSource(interaction);
  const shown: number[] = [];
  const engine = { tank: { setAlgae: (a: number) => shown.push(a) } };
  return { interaction, source, engine, shown };
}

describe('glassAlgaeAmount', () => {
  it('passes 0..1 through and clamps the rest', () => {
    expect(glassAlgaeAmount(0.4)).toBe(0.4);
    expect(glassAlgaeAmount(-0.1)).toBe(0);
    expect(glassAlgaeAmount(1.3)).toBe(1);
    expect(glassAlgaeAmount(Number.NaN)).toBe(0);
  });
});

describe('followGlassAlgae', () => {
  it('shows the algae of each water update and clears after a scrape', () => {
    const { interaction, source, engine, shown } = setup();
    followGlassAlgae(engine, source);
    interaction.emit('tank:water', { tankId: 't1', water: water(0.6) });
    interaction.emit('tank:water', { tankId: 't1', water: water(0) });
    expect(shown).toEqual([0, 0.6, 0]);
  });

  it('applies algae that arrived before the engine was up', () => {
    const { interaction, source, engine, shown } = setup();
    interaction.emit('tank:water', { tankId: 't1', water: water(0.8) });
    followGlassAlgae(engine, source);
    expect(shown).toEqual([0.8]);
  });

  it('cleans the glass when no saved tank is on show', () => {
    const { interaction, source, engine, shown } = setup();
    interaction.emit('tank:water', { tankId: 't1', water: water(0.5) });
    followGlassAlgae(engine, source);
    interaction.emit('tank:none', {});
    expect(shown).toEqual([0.5, 0]);
  });

  it('stops listening', () => {
    const { interaction, source, engine, shown } = setup();
    const stop = followGlassAlgae(engine, source);
    stop();
    interaction.emit('tank:water', { tankId: 't1', water: water(0.5) });
    expect(shown).toEqual([0]);
  });
});
