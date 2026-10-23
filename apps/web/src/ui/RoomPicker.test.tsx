// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RoomId } from '@aquarium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_STATE, type SessionState } from '../sync/state';
import { ROOM_ENTRIES } from '../sync/roomCatalog';
import type { TankSession } from '../sync/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = { paymentsState: vi.fn(), paymentsPacks: vi.fn() };
const hooks = {
  room: null as { tankId: string | null; roomId: RoomId | null } | null,
  session: null as TankSession | null,
  state: INITIAL_STATE as SessionState,
};
vi.mock('./context', () => ({ useApi: () => api, useRoomState: () => hooks.room }));
vi.mock('./session', () => ({
  useOptionalSession: () => hooks.session,
  useSessionState: () => hooks.state,
}));

vi.mock('../scene/room/roomScene', () => {
  throw new Error('the room picker must not load the room scene presets');
});

const { RoomPicker, RoomPickerView, RoomReadout } = await import('./RoomPicker');

function fakeSession(balance: number) {
  const wallet = { balance, pearlsRefused: false };
  return {
    wallet,
    getState: () => wallet,
    refreshWallet: vi.fn().mockResolvedValue(undefined),
    clearMessages: vi.fn(),
    buyRoom: vi.fn().mockResolvedValue(true),
    setRoom: vi.fn().mockResolvedValue(true),
  };
}

const stateWith = (over: Partial<SessionState> = {}): SessionState => ({
  ...INITIAL_STATE,
  activeId: 'tank-a',
  ...over,
});

describe('the room picker', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    hooks.room = null;
    hooks.session = null;
    hooks.state = INITIAL_STATE;
    api.paymentsState.mockResolvedValue({ payments: 'off' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-room-id="${id}"]`);
  const click = async (element: Element | null) => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 4; i += 1) await act(async () => {});
  };
  const confirmBuy = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Yes, buy it') ?? null;
  const render = async (
    session: ReturnType<typeof fakeSession>,
    state: SessionState,
    shown: RoomId | null = 'room-living',
  ) => {
    await act(async () => {
      root.render(
        <RoomPickerView session={session as unknown as TankSession} state={state} shown={shown} />,
      );
    });
  };

  it('lists every room and the plain studio with price and ownership', async () => {
    await render(fakeSession(2000), stateWith({ ownedRooms: ['room-zen'] }));
    expect(container.querySelectorAll('[data-room-id]')).toHaveLength(13);
    expect(button('room-living')?.textContent).toContain('Free');
    expect(button('room-zen')?.textContent).toContain('Owned');
    expect(button('room-submarine')?.textContent).toMatch(/\d[\d,]* Pearls \(about/);
    expect(button('none')?.textContent).toContain('No room');
    expect(button('room-living')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('room-bedroom')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('paints each swatch from the room catalog colours without loading the room scene', async () => {
    await render(fakeSession(0), stateWith());
    for (const entry of ROOM_ENTRIES) {
      const style = button(entry.id)?.querySelector('.room-swatch')?.getAttribute('style') ?? '';
      expect(style, entry.id).toContain(entry.swatch.key);
      expect(style, entry.id).toContain(entry.swatch.ambient);
    }
  });

  it('shows the plain studio as chosen when the tank has no room', async () => {
    await render(fakeSession(0), stateWith(), null);
    expect(button('none')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('sets a free room without buying anything', async () => {
    const session = fakeSession(0);
    await render(session, stateWith());
    await click(button('room-bedroom'));
    expect(session.setRoom).toHaveBeenCalledWith('room-bedroom');
    expect(session.buyRoom).not.toHaveBeenCalled();
  });

  it('sets no room with null', async () => {
    const session = fakeSession(0);
    await render(session, stateWith());
    await click(button('none'));
    expect(session.setRoom).toHaveBeenCalledWith(null);
  });

  it('uses a room that is already owned without charging again', async () => {
    const session = fakeSession(2000);
    await render(session, stateWith({ ownedRooms: ['room-zen'] }));
    await click(button('room-zen'));
    expect(session.setRoom).toHaveBeenCalledWith('room-zen');
    expect(session.buyRoom).not.toHaveBeenCalled();
    expect(confirmBuy()).toBeNull();
  });

  it('offers to buy a room that is not owned and does not set it', async () => {
    const session = fakeSession(2000);
    await render(session, stateWith());
    expect(button('room-zen')?.getAttribute('aria-pressed')).toBeNull();
    await click(button('room-zen'));
    expect(session.setRoom).not.toHaveBeenCalled();
    expect(session.buyRoom).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Japanese zen room');
    expect(confirmBuy()).not.toBeNull();
  });

  it('buys once and shows the room after the confirmation', async () => {
    const session = fakeSession(2000);
    await render(session, stateWith());
    await click(button('room-zen'));
    await click(confirmBuy());
    expect(session.buyRoom).toHaveBeenCalledTimes(1);
    expect(session.buyRoom).toHaveBeenCalledWith('room-zen');
    expect(session.setRoom).toHaveBeenCalledWith('room-zen');
  });

  it('charges once however often the button is pressed', async () => {
    const session = fakeSession(2000);
    await render(session, stateWith());
    await click(button('room-zen'));
    await click(button('room-zen'));
    await click(button('room-zen'));
    await click(confirmBuy());
    expect(session.buyRoom).toHaveBeenCalledTimes(1);
  });

  it('declining the confirmation buys nothing', async () => {
    const session = fakeSession(2000);
    await render(session, stateWith());
    await click(button('room-zen'));
    await click(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Not now') ?? null,
    );
    expect(session.buyRoom).not.toHaveBeenCalled();
    expect(confirmBuy()).toBeNull();
  });

  it('says plainly when the Pearls fall short and sends no purchase', async () => {
    const session = fakeSession(100);
    await render(session, stateWith({ balance: 100 }));
    await click(button('room-zen'));
    expect(session.buyRoom).not.toHaveBeenCalled();
    expect(confirmBuy()).toBeNull();
    expect(container.querySelector('.shortfall')?.textContent).toMatch(/Pearls/);
  });

  it('shows the same note when the server refuses the purchase', async () => {
    const session = fakeSession(2000);
    session.buyRoom.mockImplementation(async () => {
      session.wallet.balance = 100;
      session.wallet.pearlsRefused = true;
      return false;
    });
    await render(session, stateWith({ balance: null }));
    await click(button('room-zen'));
    await click(confirmBuy());
    expect(session.setRoom).not.toHaveBeenCalled();
    expect(container.querySelector('.shortfall')).not.toBeNull();
  });

  it('reads out the session message', async () => {
    await render(
      fakeSession(0),
      stateWith({ error: 'That room is not unlocked yet. Buy it first.' }),
    );
    expect(container.querySelector('.room-status')?.textContent).toContain('not unlocked');
  });

  it('is reachable by keyboard and named for assistive tech', async () => {
    await render(fakeSession(0), stateWith());
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.every((b) => b.tabIndex === 0 && b.type === 'button')).toBe(true);
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(button('room-shop')?.textContent).toContain('Not owned yet');
  });

  it('only names the room in a read-only view', async () => {
    await act(async () => root.render(<RoomReadout roomId="room-office" />));
    expect(container.textContent).toBe('Room: Home office');
    expect(container.querySelector('button')).toBeNull();
    await act(async () => root.render(<RoomReadout roomId={null} />));
    expect(container.textContent).toBe('Room: No room');
  });

  it('hides the picker without a saved tank and shows the room instead', async () => {
    hooks.room = { tankId: null, roomId: 'room-living' };
    await act(async () => root.render(<RoomPicker />));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('Room: Living room');
    expect(container.textContent).toContain('Sign in');
  });

  it('shows the picker for a signed-in tank', async () => {
    hooks.session = fakeSession(0) as unknown as TankSession;
    hooks.state = stateWith();
    hooks.room = { tankId: 'tank-a', roomId: 'room-bedroom' };
    await act(async () => root.render(<RoomPicker />));
    expect(button('room-bedroom')?.getAttribute('aria-pressed')).toBe('true');
  });
});
