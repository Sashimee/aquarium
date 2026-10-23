// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { UiProviders } from './context';
import { DayNightButton } from './Hud';
import { DAY_NIGHT_KEY } from './dayNight';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the day/night button', () => {
  let container: HTMLElement;
  let root: Root;
  let interaction: EventBus<InteractionEvents>;
  const requests: (number | string | null)[] = [];

  beforeEach(() => {
    localStorage.clear();
    requests.length = 0;
    interaction = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    interaction.on('clock:request', ({ clock }) => requests.push(clock));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const show = () =>
    act(() =>
      root.render(
        createElement(UiProviders, {
          bridge: { engine: new EventBus<EngineEvents>(undefined, ['engine:ready']), interaction },
          children: createElement(DayNightButton),
        }),
      ),
    );
  const button = () => container.querySelector<HTMLButtonElement>('button');

  it('labels each mode and the next, announcing the change', () => {
    show();
    expect(button()?.getAttribute('aria-label')).toBe('Lighting: automatic. Switch to day');
    act(() => button()?.click());
    expect(button()?.getAttribute('aria-label')).toBe('Lighting: day. Switch to night');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Lighting set to day');
    act(() => button()?.click());
    expect(button()?.getAttribute('aria-label')).toBe('Lighting: night. Switch to automatic');
    act(() => button()?.click());
    expect(button()?.dataset['mode']).toBe('auto');
  });

  it('requests the clock for each press and saves the choice', () => {
    show();
    act(() => button()?.click());
    act(() => button()?.click());
    act(() => button()?.click());
    expect(requests).toEqual(['day', 'night', null]);
    expect(localStorage.getItem(DAY_NIGHT_KEY)).toBe('auto');
  });

  it('labels a ?clock= page by the lamp, which an afternoon schedule leaves off at 13:00', () => {
    window.history.replaceState(null, '', '/?clock=day');
    show();
    act(() => interaction.emit('lamp:schedule', { intensity: 0.8, onHour: 14, offHour: 22 }));
    expect(button()?.dataset['mode']).toBe('night');
    window.history.replaceState(null, '', '/');
  });

  it('starts from the saved mode', () => {
    localStorage.setItem(DAY_NIGHT_KEY, 'night');
    show();
    expect(button()?.dataset['mode']).toBe('night');
  });

  it('still switches when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    show();
    act(() => button()?.click());
    expect(requests).toEqual(['day']);
    expect(button()?.dataset['mode']).toBe('day');
  });
});
