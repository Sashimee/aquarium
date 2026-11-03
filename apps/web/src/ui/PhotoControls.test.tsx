// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { UiProviders } from './context';
import { PhotoTools } from './PhotoControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('photo tools panel', () => {
  let container: HTMLElement;
  let root: Root;
  let interaction: EventBus<InteractionEvents>;
  const errors: unknown[][] = [];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    errors.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    interaction = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    interaction.emit('photo:view', {
      capturing: false,
      state: {
        active: true,
        filter: 'natural',
        depthOfField: { enabled: false, available: false, focusDistance: 1, fStop: 2.8 },
        simPaused: false,
        uiHidden: false,
        fov: 40,
      },
    });
    await act(async () => {
      root.render(
        <UiProviders
          bridge={{ engine: new EventBus<EngineEvents>(undefined, ['engine:ready']), interaction }}
        >
          <PhotoTools />
        </UiProviders>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // The panel scrolls (max-height 46dvh) and a raw mouse press never scrolls it, so a pad below
  // the sliders sat outside the visible part of the panel on short screens and presses missed it.
  it('puts the camera pad first, so it is visible without scrolling the panel', () => {
    const panel = container.querySelector('section[aria-label="Photo controls"]');
    expect(panel?.firstElementChild?.getAttribute('aria-label')).toBe('Move the camera');
    expect(errors).toEqual([]);
  });

  it('holds a move while the pad button is pressed and lets go on release', () => {
    const requests: unknown[] = [];
    interaction.on('photo:request', (command) => requests.push(command));
    const forward = container.querySelector<HTMLButtonElement>('button[aria-label="Move forward"]');
    if (!forward) throw new Error('no Move forward button');
    forward.setPointerCapture = vi.fn();
    const fire = (type: string) =>
      act(() => {
        forward.dispatchEvent(
          Object.assign(new MouseEvent(type, { bubbles: true }), { pointerId: 1 }),
        );
      });
    fire('pointerdown');
    fire('pointerup');
    expect(requests).toEqual([
      { type: 'hold', move: 'forward', down: true },
      { type: 'hold', move: 'forward', down: false },
    ]);
  });
});
