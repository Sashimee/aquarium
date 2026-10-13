import { describe, expect, it } from 'vitest';
import {
  CLOSED,
  PANELS,
  decorRequestFor,
  nextPanel,
  type Panel,
  type PanelAction,
  type PanelState,
} from './panels';

const at = (panel: Panel, newTank: PanelState['newTank'] = null): PanelState => ({
  panel,
  newTank,
});

describe('nextPanel', () => {
  it('toggles each panel open and closed', () => {
    for (const panel of PANELS) {
      expect(nextPanel(CLOSED, { type: 'toggle', panel })).toEqual(at(panel));
      expect(nextPanel(at(panel), { type: 'toggle', panel })).toEqual(CLOSED);
    }
  });

  it('replaces the open panel instead of stacking', () => {
    for (const from of PANELS) {
      for (const to of PANELS) {
        if (from === to) continue;
        expect(nextPanel(at(from), { type: 'toggle', panel: to }).panel).toBe(to);
      }
    }
  });

  it('open is idempotent and replaces whatever was open', () => {
    expect(nextPanel(at('care'), { type: 'open', panel: 'care' })).toEqual(at('care'));
    expect(nextPanel(at('decor'), { type: 'open', panel: 'care' })).toEqual(at('care'));
  });

  it('a new-tank choice opens the tanks panel and remembers the kind', () => {
    expect(nextPanel(CLOSED, { type: 'new-tank', biome: 'reef' })).toEqual(at('tanks', 'reef'));
    expect(nextPanel(at('decor'), { type: 'new-tank', biome: 'freshwater' })).toEqual(
      at('tanks', 'freshwater'),
    );
    expect(nextPanel(at('tanks', 'reef'), { type: 'new-tank', biome: 'freshwater' })).toEqual(
      at('tanks', 'freshwater'),
    );
  });

  it('forgets the new-tank choice when the panel is closed or replaced', () => {
    const asked = at('tanks', 'reef');
    expect(nextPanel(asked, { type: 'close' })).toEqual(CLOSED);
    expect(nextPanel(asked, { type: 'toggle', panel: 'tanks' })).toEqual(CLOSED);
    expect(nextPanel(asked, { type: 'toggle', panel: 'shop' })).toEqual(at('shop'));
  });

  it('the tank report is one of the exclusive panels', () => {
    expect(nextPanel(at('report'), { type: 'toggle', panel: 'care' })).toEqual(at('care'));
    expect(nextPanel(at('care'), { type: 'toggle', panel: 'report' })).toEqual(at('report'));
  });

  it('close always lands on none', () => {
    for (const panel of ['none', ...PANELS] as const) {
      expect(nextPanel(at(panel), { type: 'close' })).toEqual(CLOSED);
    }
  });

  it('follows decor mode started by the engine and leaves other panels alone when it stops', () => {
    expect(nextPanel(at('shop'), { type: 'decor-changed', active: true })).toEqual(at('decor'));
    expect(nextPanel(at('decor'), { type: 'decor-changed', active: false })).toEqual(CLOSED);
    expect(nextPanel(at('shop'), { type: 'decor-changed', active: false })).toEqual(at('shop'));
    expect(nextPanel(CLOSED, { type: 'decor-changed', active: false })).toEqual(CLOSED);
  });

  it('closes every panel when a route screen opens and keeps them on the tank', () => {
    for (const panel of PANELS) {
      expect(nextPanel(at(panel), { type: 'route-changed', home: false })).toEqual(CLOSED);
      expect(nextPanel(at(panel), { type: 'route-changed', home: true })).toEqual(at(panel));
    }
  });

  it('always yields a valid panel and drops a stale new-tank choice for any two actions', () => {
    const actions: PanelAction[] = [
      ...PANELS.flatMap((panel): PanelAction[] => [
        { type: 'toggle', panel },
        { type: 'open', panel },
      ]),
      { type: 'new-tank', biome: 'reef' },
      { type: 'close' },
      { type: 'decor-changed', active: true },
      { type: 'decor-changed', active: false },
      { type: 'route-changed', home: false },
      { type: 'route-changed', home: true },
    ];
    const valid: Panel[] = ['none', ...PANELS];
    for (const start of [CLOSED, ...PANELS.map((p) => at(p))]) {
      for (const a of actions) {
        for (const b of actions) {
          const end = nextPanel(nextPanel(start, a), b);
          expect(valid).toContain(end.panel);
          if (end.panel !== 'tanks') expect(end.newTank).toBeNull();
        }
      }
    }
  });
});

describe('decorRequestFor', () => {
  it('asks for decor mode only when it is entered or left', () => {
    expect(decorRequestFor('none', 'decor')).toEqual({ active: true });
    expect(decorRequestFor('tanks', 'decor')).toEqual({ active: true });
    expect(decorRequestFor('decor', 'shop')).toEqual({ active: false });
    expect(decorRequestFor('decor', 'none')).toEqual({ active: false });
    expect(decorRequestFor('care', 'none')).toBeNull();
    expect(decorRequestFor('none', 'feed')).toBeNull();
    expect(decorRequestFor('decor', 'decor')).toBeNull();
  });
});
