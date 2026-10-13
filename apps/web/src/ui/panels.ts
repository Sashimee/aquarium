import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge, useDecorState } from './context';

export type Panel = 'none' | 'tank' | 'decor';

export type PanelAction =
  | { type: 'toggle-tank' }
  | { type: 'open-tank' }
  | { type: 'toggle-decor' }
  | { type: 'close' }
  | { type: 'decor-changed'; active: boolean };

export function nextPanel(current: Panel, action: PanelAction): Panel {
  switch (action.type) {
    case 'toggle-tank':
      return current === 'tank' ? 'none' : 'tank';
    case 'open-tank':
      return 'tank';
    case 'toggle-decor':
      return current === 'decor' ? 'none' : 'decor';
    case 'close':
      return 'none';
    case 'decor-changed':
      if (action.active) return 'decor';
      return current === 'decor' ? 'none' : current;
  }
}

export function decorRequestFor(before: Panel, after: Panel): { active: boolean } | null {
  if ((before === 'decor') === (after === 'decor')) return null;
  return { active: after === 'decor' };
}

// Decor mode lives in the engine, so changes it makes on its own (Done, a failed start) are folded
// back in on a flip of its state rather than by level, which would replay a stale sticky value.
export function usePanels(): { panel: Panel; dispatch(action: PanelAction): void } {
  const { interaction } = useBridge();
  const engineActive = useDecorState()?.active ?? false;
  const [panel, setPanel] = useState<Panel>('none');
  const current = useRef<Panel>('none');

  const dispatch = useCallback(
    (action: PanelAction) => {
      const before = current.current;
      const after = nextPanel(before, action);
      current.current = after;
      setPanel(after);
      const request = decorRequestFor(before, after);
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

  return { panel, dispatch };
}
