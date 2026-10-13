import { describe, expect, it } from 'vitest';
import { checkFishName, checkTankName, suggestFishName, suggestTankName } from './naming';

describe('naming', () => {
  it('trims and accepts a good name', () => {
    expect(checkFishName('  Pip ')).toEqual({ ok: true, name: 'Pip' });
    expect(checkTankName(' Den')).toEqual({ ok: true, name: 'Den' });
  });

  it('asks for a name when blank', () => {
    expect(checkFishName('   ')).toEqual({ ok: false, message: 'Give the fish a name.' });
    expect(checkTankName('')).toEqual({ ok: false, message: 'Give the tank a name.' });
  });

  it('refuses an over-long name', () => {
    expect(checkFishName('x'.repeat(500))).toEqual({
      ok: false,
      message: 'That fish name is too long.',
    });
  });

  it('suggests a fish name nobody in the tank has, ignoring case', () => {
    expect(suggestFishName(['pip', 'Bubbles'])).toBe('Marlow');
  });

  it('numbers the fish when every stock name is taken', () => {
    const stock = Array.from({ length: 20 }, (_, i) => `n${i}`);
    expect(suggestFishName(stock)).not.toMatch(/^Fish/);
    const all = [
      'Pip',
      'Bubbles',
      'Marlow',
      'Coral',
      'Finn',
      'Dot',
      'Nemo',
      'Sprout',
      'Misty',
      'Ripple',
      'Pebble',
      'Comet',
      'Juniper',
      'Skye',
      'Tango',
      'Olive',
      'Ziggy',
      'Wren',
      'Maple',
      'Echo',
    ];
    expect(suggestFishName(all)).toBe('Fish 21');
  });

  it('suggests a unique tank name per biome', () => {
    expect(suggestTankName('reef', [])).toBe('Reef tank');
    expect(suggestTankName('freshwater', ['Freshwater tank', 'freshwater tank 2'])).toBe(
      'Freshwater tank 3',
    );
  });
});
