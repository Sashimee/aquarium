import { isFreeRoom, type RoomId } from '@aquarium/shared';
import { useId } from 'react';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { priceOrFree } from '../sync/economy';
import { NO_ROOM_TITLE, ROOM_ENTRIES, roomTitle } from '../sync/roomCatalog';
import type { SessionState, TankSession } from '../sync/session';
import { ROOM_PRESET_DATA } from '../scene/room/roomScene';
import { useRoomState } from './context';
import { useOptionalSession, useSessionState } from './session';
import { useSpend } from './spend';

interface Choice {
  id: RoomId | null;
  title: string;
  hasWindow: boolean;
  price: number;
  swatch: string;
}

const NO_ROOM_SWATCH = 'linear-gradient(135deg, #1b2733, #0d141b)';

const CHOICES: readonly Choice[] = [
  ...ROOM_ENTRIES.map((entry) => {
    const light = ROOM_PRESET_DATA[entry.id].light;
    return {
      id: entry.id,
      title: entry.name,
      hasWindow: entry.hasWindow,
      price: BUNDLED_ECONOMY.rooms[entry.id],
      swatch: `linear-gradient(135deg, ${light.keyColor}, ${light.ambientColor})`,
    };
  }),
  { id: null, title: NO_ROOM_TITLE, hasWindow: false, price: 0, swatch: NO_ROOM_SWATCH },
];

export function RoomPickerView({
  session,
  state,
  shown,
}: {
  session: TankSession;
  state: SessionState;
  shown: RoomId | null;
}) {
  const heading = useId();
  const { spend, notice } = useSpend(session, state.balance);
  const owns = (id: RoomId | null) =>
    id === null || isFreeRoom(id) || state.ownedRooms.includes(id);

  const choose = (choice: Choice) => {
    const { id } = choice;
    if (owns(id)) {
      void session.setRoom(id);
      return;
    }
    if (id === null) return;
    void spend({
      label: `the ${choice.title}`,
      price: choice.price,
      confirm: true,
      go: async () => {
        if (!(await session.buyRoom(id))) return false;
        await session.setRoom(id);
        return true;
      },
    });
  };

  return (
    <div className="block room-picker" role="group" aria-labelledby={heading}>
      <h3 id={heading}>Room</h3>
      <p className="hint">
        The room around the tank. Paid rooms are bought once and then work in all your tanks.
      </p>
      <ul className="room-choices">
        {CHOICES.map((choice) => {
          const owned = owns(choice.id);
          const status = owned
            ? choice.price === 0
              ? 'Free'
              : 'Owned'
            : priceOrFree(choice.price, BUNDLED_ECONOMY);
          const selected = choice.id === shown;
          return (
            <li key={choice.id ?? 'none'}>
              <button
                type="button"
                className="room-choice"
                data-room-id={choice.id ?? 'none'}
                data-room-owned={owned}
                aria-pressed={owned ? selected : undefined}
                disabled={state.busy}
                onClick={() => choose(choice)}
              >
                <span
                  className="room-swatch"
                  style={{ background: choice.swatch }}
                  aria-hidden="true"
                />
                <span className="room-name">{choice.title}</span>
                <span className="hint">
                  {status}
                  {choice.id !== null && (choice.hasWindow ? ', with a window' : ', no window')}
                </span>
                <span className="sr-only">
                  {owned
                    ? selected
                      ? 'Shown now.'
                      : 'Show this room.'
                    : 'Not owned yet. Buy it to use it.'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {notice}
      <p role="status" className="room-status">
        {state.error ?? ''}
      </p>
    </div>
  );
}

export function RoomReadout({ roomId }: { roomId: RoomId | null }) {
  return (
    <p className="hint room-readout" data-room-id={roomId ?? 'none'}>
      Room: {roomTitle(roomId)}
    </p>
  );
}

/** The picker for the signed-in player's tank; everyone else only sees which room it is. */
export function RoomPicker() {
  const session = useOptionalSession();
  const state = useSessionState();
  const shown = useRoomState()?.roomId ?? null;
  if (!session || !state.activeId) {
    return (
      <div className="block room-picker">
        <h3>Room</h3>
        <RoomReadout roomId={shown} />
        <p className="hint">Sign in to choose a room for your tank.</p>
      </div>
    );
  }
  return <RoomPickerView session={session} state={state} shown={shown} />;
}
