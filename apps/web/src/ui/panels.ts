import type { PlayableBiome } from '@aquarium/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge, useDecorState } from './context';

export const PANELS = [
  'feed',
  'play',
  'decor',
  'shop',
  'care',
  'tanks',
  'report',
  'account',
] as const;

export type OpenPanel = (typeof PANELS)[number];
export type Panel = 'none' | OpenPanel;

export interface PanelState {
  panel: Panel;
  /** The kind of tank the player asked to start from the type switch; shown in the tanks panel. */
  newTank: PlayableBiome | null;
}

export type PanelAction =
  | { type: 'toggle'; panel: OpenPanel }
  | { type: 'open'; panel: OpenPanel }
  | { type: 'new-tank'; biome: PlayableBiome }
  | { type: 'close' }
  | { type: 'decor-changed'; active: boolean }
  | { type: 'route-changed'; home: boolean };

export const CLOSED: PanelState = { panel: 'none', newTank: null };

const opened = (panel: OpenPanel): PanelState => ({ panel, newTank: null });

export function nextPanel(current: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'toggle':
      return current.panel === action.panel ? CLOSED : opened(action.panel);
    case 'open':
      return opened(action.panel);
    case 'new-tank':
      return { panel: 'tanks', newTank: action.biome };
    case 'close':
      return CLOSED;
    case 'decor-changed':
      if (action.active) return opened('decor');
      return current.panel === 'decor' ? CLOSED : current;
    case 'route-changed':
      return action.home ? current : CLOSED;
  }
}

export function decorRequestFor(before: Panel, after: Panel): { active: boolean } | null {
  if ((before === 'decor') === (after === 'decor')) return null;
  return { active: after === 'decor' };
}

/**
 * Decorate mode lives in the engine. A start requested before the scene is ready is queued there,
 * so the decor panel can be open while the engine is still inactive. Changes the engine makes on
 * its own (a started or finished edit) are folded back in on a flip of its state rather than by
 * level, which would replay a stale sticky value.
 */
export function usePanels(): PanelState & { dispatch(action: PanelAction): void } {
  const { interaction } = useBridge();
  const engineActive = useDecorState()?.active ?? false;
  const [state, setState] = useState<PanelState>(CLOSED);
  const current = useRef<PanelState>(CLOSED);

  const dispatch = useCallback(
    (action: PanelAction) => {
      const before = current.current;
      const after = nextPanel(before, action);
      if (after.panel === before.panel && after.newTank === before.newTank) return;
      current.current = after;
      setState(after);
      const request = decorRequestFor(before.panel, after.panel);
      if (request && action.type !== 'decor-changed') {
        interaction.emit('decor:request-mode', request);
      }
    },
    [interaction],
  );

  const seen = useRef(engineActive);
  useEffect(() => {
    if (seen.current === engineActive) return;
    seen.current = engineActive;
    dispatch({ type: 'decor-changed', active: engineActive });
  }, [engineActive, dispatch]);

  return { ...state, dispatch };
}
