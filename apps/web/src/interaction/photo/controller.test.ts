import { describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../../engine/events';
import type { PhotoState } from '../../engine/photo/PhotoMode';
import type { InteractionEvents } from '../events';
import {
  actionForKey,
  describeCaptureError,
  FAST_FACTOR,
  MOVE_SPEED,
  PhotoController,
  type PhotoPort,
} from './controller';

function stateOf(over: Partial<PhotoState> = {}): PhotoState {
  return {
    active: true,
    filter: 'natural',
    depthOfField: { enabled: false, available: true, focusDistance: 0.45, fStop: 2.8 },
    simPaused: false,
    uiHidden: false,
    fov: 40,
    ...over,
  };
}

function setup(over: Partial<PhotoState> = {}, dialogOpen = false) {
  let state = stateOf(over);
  const port = {
    get active() {
      return state.active;
    },
    get state() {
      return state;
    },
    enter: vi.fn(() => {
      state = { ...state, active: true };
    }),
    exit: vi.fn(() => {
      state = { ...state, active: false };
    }),
    turn: vi.fn(),
    move: vi.fn(),
    setFov: vi.fn(),
    setFilter: vi.fn(),
    setDepthOfField: vi.fn(),
    focusAt: vi.fn(() => null),
    setSimPaused: vi.fn(),
    setUiHidden: vi.fn((hidden: boolean) => {
      state = { ...state, uiHidden: hidden };
    }),
    capture: vi.fn<() => Promise<Blob>>(),
  } satisfies PhotoPort;
  const interaction = new EventBus<InteractionEvents>();
  const engineEvents = new EventBus<EngineEvents>();
  const layer = {} as HTMLElement;
  const controller = new PhotoController({
    port,
    interaction,
    engineEvents,
    uiLayer: () => layer,
    viewHeight: () => 500,
    dialogOpen: () => dialogOpen,
  });
  const outcomes: InteractionEvents['photo:capture'][] = [];
  interaction.on('photo:capture', (o) => outcomes.push(o));
  const views: boolean[] = [];
  interaction.on('photo:view', (v) => views.push(v.capturing));
  const key = (k: string, target: unknown = null) =>
    controller.keyDown({
      key: k,
      target: target as EventTarget | null,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
  return { port, interaction, engineEvents, controller, outcomes, views, layer, key };
}

describe('commands', () => {
  it('enters with the overlay to hide', () => {
    const { port, interaction, layer } = setup({ active: false });
    interaction.emit('photo:request', { type: 'enter' });
    expect(port.enter).toHaveBeenCalledWith({ uiLayer: layer });
  });

  it('passes only the lens fields that were given', () => {
    const { port, interaction } = setup();
    interaction.emit('photo:request', { type: 'dof', focusDistance: 1.2 });
    expect(port.setDepthOfField).toHaveBeenCalledWith({ focusDistance: 1.2 });
  });

  it('ignores changes while photo mode is closed instead of throwing', () => {
    const { port, interaction } = setup({ active: false });
    interaction.emit('photo:request', { type: 'fov', degrees: 30 });
    interaction.emit('photo:request', { type: 'freeze', paused: true });
    interaction.emit('photo:request', { type: 'hide-ui', hidden: true });
    expect(port.setFov).not.toHaveBeenCalled();
    expect(port.setSimPaused).not.toHaveBeenCalled();
    expect(port.setUiHidden).not.toHaveBeenCalled();
  });

  it('republishes the state when the engine announces a change', () => {
    const { engineEvents, interaction } = setup();
    const seen: PhotoState[] = [];
    interaction.on('photo:view', (v) => seen.push(v.state));
    engineEvents.emit('photo:changed', stateOf());
    expect(seen).toHaveLength(1);
  });
});

describe('camera input', () => {
  it('turns the picture with the finger: right and down look left and up', () => {
    const { port, controller } = setup({ fov: 50 });
    controller.drag(10, -20);
    const perPixel = (50 * Math.PI) / 180 / 500;
    expect(port.turn).toHaveBeenCalledWith(10 * perPixel, -20 * perPixel);
  });

  it('turns less per pixel when zoomed in', () => {
    const wide = setup({ fov: 70 });
    const tight = setup({ fov: 20 });
    wide.controller.drag(10, 0);
    tight.controller.drag(10, 0);
    const [wideYaw] = wide.port.turn.mock.calls[0] ?? [0];
    const [tightYaw] = tight.port.turn.mock.calls[0] ?? [0];
    expect(tightYaw).toBeLessThan(wideYaw);
  });

  it('widens on a factor above 1 and narrows below it, and rejects nonsense factors', () => {
    const { port, controller } = setup({ fov: 40 });
    controller.zoom(1.5);
    controller.zoom(0.5);
    controller.zoom(0);
    controller.zoom(Number.NaN);
    expect(port.setFov.mock.calls).toEqual([[60], [20]]);
  });

  it('does nothing while closed', () => {
    const { port, controller } = setup({ active: false });
    controller.drag(5, 5);
    controller.zoom(2);
    controller.tap(1, 1);
    expect(port.turn).not.toHaveBeenCalled();
    expect(port.setFov).not.toHaveBeenCalled();
    expect(port.focusAt).not.toHaveBeenCalled();
  });

  it('focuses on a tap only when depth of field is on', () => {
    const off = setup();
    off.controller.tap(10, 20);
    expect(off.port.focusAt).not.toHaveBeenCalled();
    const on = setup({
      depthOfField: { enabled: true, available: true, focusDistance: 1, fStop: 2.8 },
    });
    on.controller.tap(10, 20);
    expect(on.port.focusAt).toHaveBeenCalledWith(10, 20);
  });
});

describe('held keys and pad buttons', () => {
  it('moves by speed times the frame time, and faster with shift', () => {
    const { port, controller, key } = setup();
    key('w');
    key('d');
    controller.update(0.1);
    expect(port.move).toHaveBeenLastCalledWith(MOVE_SPEED * 0.1, 0, MOVE_SPEED * 0.1);
    key('Shift');
    controller.update(0.1);
    expect(port.move).toHaveBeenLastCalledWith(
      MOVE_SPEED * 0.1 * FAST_FACTOR,
      0,
      MOVE_SPEED * 0.1 * FAST_FACTOR,
    );
  });

  it('cancels opposite keys and stops on release', () => {
    const { port, controller, key } = setup();
    key('a');
    key('d');
    controller.update(0.05);
    expect(port.move).not.toHaveBeenCalled();
    controller.keyUp('a');
    controller.keyUp('d');
    key('e');
    controller.keyUp('e');
    controller.update(0.05);
    expect(port.move).not.toHaveBeenCalled();
  });

  it('caps a long frame so a stalled tab does not teleport the camera', () => {
    const { port, controller, key } = setup();
    key('w');
    controller.update(5);
    expect(port.move).toHaveBeenCalledWith(0, 0, MOVE_SPEED * 0.1);
  });

  it('holds from the on-screen pad like a key', () => {
    const { port, controller, interaction } = setup();
    interaction.emit('photo:request', { type: 'hold', move: 'up', down: true });
    controller.update(0.1);
    expect(port.move).toHaveBeenCalledWith(0, MOVE_SPEED * 0.1, 0);
    interaction.emit('photo:request', { type: 'hold', move: 'up', down: false });
    controller.update(0.1);
    expect(port.move).toHaveBeenCalledTimes(1);
  });

  it('turns and zooms with arrows and plus/minus', () => {
    const { port, controller, key } = setup({ fov: 40 });
    key('ArrowLeft');
    key('-');
    controller.update(0.1);
    expect(port.turn).toHaveBeenCalledWith(0.1, 0);
    expect(port.setFov).toHaveBeenCalledWith(44);
  });

  it('lets go of everything when the window loses focus', () => {
    const { port, controller, key } = setup();
    key('w');
    controller.releaseAll();
    controller.update(0.1);
    expect(port.move).not.toHaveBeenCalled();
  });

  it('leaves form fields and open dialogs alone', () => {
    const { key, port, controller } = setup();
    expect(key('a', { tagName: 'INPUT' })).toBe(false);
    controller.update(0.1);
    expect(port.move).not.toHaveBeenCalled();
    const dialog = setup({}, true);
    expect(dialog.key('Escape')).toBe(false);
    expect(dialog.port.exit).not.toHaveBeenCalled();
  });

  it('exits on Escape, toggles the controls on H and ignores other keys', () => {
    const { key, port } = setup();
    expect(key('x')).toBe(false);
    expect(key('h')).toBe(true);
    expect(port.setUiHidden).toHaveBeenLastCalledWith(true);
    expect(key('H')).toBe(true);
    expect(port.setUiHidden).toHaveBeenLastCalledWith(false);
    expect(key('Escape')).toBe(true);
    expect(port.exit).toHaveBeenCalledTimes(1);
  });

  it('ignores keys while closed', () => {
    const { key } = setup({ active: false });
    expect(key('w')).toBe(false);
  });

  it('knows both cases of letter keys', () => {
    expect(actionForKey('W')).toBe('forward');
    expect(actionForKey('Enter')).toBeNull();
  });
});

describe('capture', () => {
  it('reports busy while waiting, then hands over the image', async () => {
    const { port, interaction, outcomes, views } = setup();
    const blob = new Blob(['png'], { type: 'image/png' });
    port.capture.mockResolvedValue(blob);
    interaction.emit('photo:request', { type: 'capture' });
    expect(views).toEqual([true]);
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({ status: 'done', blob });
    expect(views).toEqual([true, false]);
  });

  it('refuses a second capture without disturbing the first', async () => {
    const { port, interaction, outcomes, views } = setup();
    let finish: (blob: Blob) => void = () => undefined;
    port.capture.mockReturnValue(new Promise<Blob>((resolve) => (finish = resolve)));
    interaction.emit('photo:request', { type: 'capture' });
    interaction.emit('photo:request', { type: 'capture' });
    expect(port.capture).toHaveBeenCalledTimes(1);
    expect(outcomes).toMatchObject([{ status: 'failed', reason: 'concurrent' }]);
    expect(views).toEqual([true]);
    finish(new Blob(['x']));
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toMatchObject({ status: 'done' });
    expect(views).toEqual([true, false]);
  });

  it('reports the effects timeout', async () => {
    const { port, interaction, outcomes, views } = setup();
    port.capture.mockRejectedValue(
      new Error('Render effects not ready after 15000 ms; try the capture again'),
    );
    interaction.emit('photo:request', { type: 'capture' });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(views).toEqual([true, false]);
  });

  it('reports leaving photo mode while waiting', async () => {
    const { port, interaction, outcomes } = setup();
    let fail: (error: Error) => void = () => undefined;
    port.capture.mockReturnValue(new Promise<Blob>((_resolve, reject) => (fail = reject)));
    interaction.emit('photo:request', { type: 'capture' });
    interaction.emit('photo:request', { type: 'exit' });
    fail(new Error('capture: photo mode ended before the capture'));
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'exited' });
  });

  it('can capture again after a failure', async () => {
    const { port, interaction, outcomes } = setup();
    port.capture.mockRejectedValueOnce(new Error('boom'));
    port.capture.mockResolvedValueOnce(new Blob(['x']));
    interaction.emit('photo:request', { type: 'capture' });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    interaction.emit('photo:request', { type: 'capture' });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'done']);
  });
});

describe('describeCaptureError', () => {
  it('tells the engine errors apart', () => {
    expect(describeCaptureError(new Error('capture: a capture is already running'), true)).toEqual(
      expect.objectContaining({ reason: 'concurrent' }),
    );
    expect(
      describeCaptureError(new Error('capture: the canvas has no area (0 x 0 CSS px)'), true),
    ).toEqual(
      expect.objectContaining({
        reason: 'failed',
        message: expect.stringContaining('no area') as string,
      }),
    );
    expect(describeCaptureError('plain string', true).reason).toBe('failed');
  });

  it('blames the exit even when the engine message says something else', () => {
    expect(
      describeCaptureError(new Error('photo mode: capture() outside photo mode'), false),
    ).toEqual(expect.objectContaining({ reason: 'exited' }));
  });
});

describe('dispose', () => {
  it('stops listening and leaves photo mode', () => {
    const { port, controller, interaction } = setup();
    controller.dispose();
    expect(port.exit).toHaveBeenCalledTimes(1);
    interaction.emit('photo:request', { type: 'exit' });
    expect(port.exit).toHaveBeenCalledTimes(1);
  });
});
