import { VACATION_FEEDER_ASSET_ID } from '../interaction/decor/spec';
import type { DecorCommand } from '../interaction/events';
import { backgroundOptions } from './backgroundTitles';
import {
  useBackgroundState,
  useBridge,
  useDecorLoadError,
  useDecorSaveState,
  useDecorState,
} from './context';

const TURN = Math.PI / 12;
const STEP = 0.02;

const SAVE_TEXT = {
  idle: '',
  saving: 'Saving your changes.',
  retrying: 'Could not reach the server. Trying again.',
  saved: 'Changes saved.',
  error: 'Your changes could not be saved.',
} as const;

export function BackgroundChooser() {
  const { interaction } = useBridge();
  const shown = useBackgroundState();
  const options = shown ? backgroundOptions(shown.biome) : [];
  if (!shown || options.length === 0) return null;
  return (
    <div className="block" role="group" aria-labelledby="background-heading">
      <h3 id="background-heading">Background</h3>
      <ul className="decor-pieces">
        {options.map(({ id, title }) => (
          <li key={id}>
            <button
              type="button"
              aria-pressed={id === shown.backgroundId}
              onClick={() => interaction.emit('background:choose', { backgroundId: id })}
            >
              {title}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DecorPanel() {
  const { interaction } = useBridge();
  const state = useDecorState();
  const save = useDecorSaveState();
  const loadError = useDecorLoadError();
  if (!state?.active) {
    if (loadError) {
      return (
        <>
          <p role="alert" className="hint">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => interaction.emit('decor:request-mode', { active: true })}
          >
            Try again
          </button>
        </>
      );
    }
    return (
      <p role="status" className="hint">
        Getting the tank ready for decorating.
      </p>
    );
  }
  const send = (command: DecorCommand) => interaction.emit('decor:command', command);
  const selected = state.pieces.find((p) => p.id === state.selectedId) ?? null;

  return (
    <>
      <p className="hint">
        Drag a piece in the tank to move it, or pick it from the list and use the buttons. Pieces
        drop onto the gravel and cannot overlap.
      </p>

      <BackgroundChooser />

      <div className="block">
        <h3>Add a piece</h3>
        <ul className="decor-palette">
          {state.palette.map((entry) => {
            const blocked = entry.assetId === VACATION_FEEDER_ASSET_ID && state.hasFeeder;
            return (
              <li key={entry.assetId}>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => send({ type: 'add', assetId: entry.assetId })}
                >
                  Add {entry.label}
                </button>
                {entry.assetId === VACATION_FEEDER_ASSET_ID && (
                  <span className="hint">
                    {blocked
                      ? ' This tank already has its one vacation feeder.'
                      : ' Slows hunger by half while you are away.'}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="block">
        <h3>In the tank</h3>
        {state.pieces.length === 0 ? (
          <p className="hint">Nothing placed yet.</p>
        ) : (
          <ul className="decor-pieces">
            {state.pieces.map((piece) => (
              <li key={piece.id}>
                <button
                  type="button"
                  aria-pressed={piece.id === state.selectedId}
                  onClick={() => send({ type: 'select', id: piece.id })}
                >
                  {piece.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="block" role="group" aria-label={`Adjust ${selected.label}`}>
          <h3>{selected.label}</h3>
          <div className="decor-nudge">
            <button
              type="button"
              onClick={() => send({ type: 'nudge', id: selected.id, dx: 0, dz: -STEP })}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => send({ type: 'nudge', id: selected.id, dx: -STEP, dz: 0 })}
            >
              Left
            </button>
            <button
              type="button"
              onClick={() => send({ type: 'nudge', id: selected.id, dx: STEP, dz: 0 })}
            >
              Right
            </button>
            <button
              type="button"
              onClick={() => send({ type: 'nudge', id: selected.id, dx: 0, dz: STEP })}
            >
              Forward
            </button>
          </div>
          <div className="decor-turn">
            <button
              type="button"
              onClick={() => send({ type: 'rotate', id: selected.id, radians: -TURN })}
            >
              Turn left
            </button>
            <button
              type="button"
              onClick={() => send({ type: 'rotate', id: selected.id, radians: TURN })}
            >
              Turn right
            </button>
            <button type="button" onClick={() => send({ type: 'remove', id: selected.id })}>
              Remove
            </button>
          </div>
        </div>
      )}

      <p role="status" className="decor-status">
        {state.problem ?? ''}
      </p>
      <p role="status" className="decor-save">
        {state.persisted
          ? save.status === 'error'
            ? (save.message ?? SAVE_TEXT.error)
            : SAVE_TEXT[save.status]
          : 'This is the demo tank, so your layout is not saved. Sign in to keep it.'}
      </p>
      {state.persisted && save.status === 'error' && (
        <button type="button" onClick={() => send({ type: 'retry-save' })}>
          Try saving again
        </button>
      )}
    </>
  );
}
