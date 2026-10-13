import { describe, expect, it } from 'vitest';
import { decorRequestFor, nextPanel, type Panel, type PanelAction } from './panels';

const panels: Panel[] = ['none', 'tank', 'decor'];

describe('nextPanel', () => {
  it('toggles each panel open and closed', () => {
    expect(nextPanel('none', { type: 'toggle-tank' })).toBe('tank');
    expect(nextPanel('tank', { type: 'toggle-tank' })).toBe('none');
    expect(nextPanel('none', { type: 'toggle-decor' })).toBe('decor');
    expect(nextPanel('decor', { type: 'toggle-decor' })).toBe('none');
  });

  it('replaces the open panel instead of stacking', () => {
    expect(nextPanel('decor', { type: 'toggle-tank' })).toBe('tank');
    expect(nextPanel('tank', { type: 'toggle-decor' })).toBe('decor');
    expect(nextPanel('decor', { type: 'open-tank' })).toBe('tank');
  });

  it('open-tank is idempotent', () => {
    expect(nextPanel('tank', { type: 'open-tank' })).toBe('tank');
  });

  it('close always lands on none', () => {
    for (const p of panels) expect(nextPanel(p, { type: 'close' })).toBe('none');
  });

  it('follows decor mode started by the engine and leaves other panels alone when it stops', () => {
    expect(nextPanel('tank', { type: 'decor-changed', active: true })).toBe('decor');
    expect(nextPanel('decor', { type: 'decor-changed', active: false })).toBe('none');
    expect(nextPanel('tank', { type: 'decor-changed', active: false })).toBe('tank');
    expect(nextPanel('none', { type: 'decor-changed', active: false })).toBe('none');
  });

  it('always yields a valid panel for any two-action sequence', () => {
    const actions: PanelAction[] = [
      { type: 'toggle-tank' },
      { type: 'open-tank' },
      { type: 'toggle-decor' },
      { type: 'close' },
      { type: 'decor-changed', active: true },
      { type: 'decor-changed', active: false },
    ];
    for (const start of panels) {
      for (const a of actions) {
        for (const b of actions) {
          expect(panels).toContain(nextPanel(nextPanel(start, a), b));
        }
      }
    }
  });
});

describe('decorRequestFor', () => {
  it('asks for decor mode only when it is entered or left', () => {
    expect(decorRequestFor('none', 'decor')).toEqual({ active: true });
    expect(decorRequestFor('tank', 'decor')).toEqual({ active: true });
    expect(decorRequestFor('decor', 'tank')).toEqual({ active: false });
    expect(decorRequestFor('decor', 'none')).toEqual({ active: false });
    expect(decorRequestFor('tank', 'none')).toBeNull();
    expect(decorRequestFor('none', 'tank')).toBeNull();
    expect(decorRequestFor('decor', 'decor')).toBeNull();
  });
});
