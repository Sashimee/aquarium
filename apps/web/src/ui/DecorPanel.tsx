import { VACATION_FEEDER_ASSET_ID } from '../interaction/decor/spec';
import type { DecorCommand } from '../interaction/events';
import { useBridge, useDecorSaveState, useDecorState } from './context';

const TURN = Math.PI / 12;
const STEP = 0.02;

const SAVE_TEXT = {
  idle: '',
  saving: 'Saving the layout.',
  saved: 'Layout saved.',
  error: 'The layout could not be saved.',
} as const;

export default function DecorPanel() {
  const { interaction } = useBridge();
  const state = useDecorState();
  const save = useDecorSaveState();
  if (!state?.active) return null;
  const send = (command: DecorCommand) => interaction.emit('decor:command', command);
  const selected = state.pieces.find((p) => p.id === state.selectedId) ?? null;

  return (
    <section className="panel decor-panel" aria-label="Decorate the tank">
      <div className="panel-head">
        <h2>Decorate</h2>
        <button
          type="button"
          onClick={() => interaction.emit('decor:request-mode', { active: false })}
        >
          Done
        </button>
      </div>
      <p className="hint">
        Drag a piece in the tank to move it, or pick it from the list and use the buttons. Pieces
        drop onto the gravel and cannot overlap.
      </p>

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
    </section>
  );
}
