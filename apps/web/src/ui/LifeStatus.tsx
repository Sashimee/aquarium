import { useEffect, useState } from 'react';
import { useBridge } from './context';
import { useSessionState, useSpeciesNames, useTankSession } from './session';

/** Speaks and shows what just happened: chores done, errors, and a fish dying while you watch. */
export function LifeStatus() {
  const session = useTankSession();
  const { interaction } = useBridge();
  const state = useSessionState();
  const names = useSpeciesNames();
  const [died, setDied] = useState<string | null>(null);

  useEffect(
    () =>
      interaction.on('tank:fish-died', ({ fish }) => {
        const species = names.get(fish.species)?.toLowerCase() ?? 'fish';
        setDied(`${fish.name} the ${species} has died. You can net them when you are ready.`);
      }),
    [interaction, names],
  );

  const text = state.error ?? state.notice ?? died;
  return (
    <div className="life-status" role={state.error ? 'alert' : 'status'} aria-live="polite">
      {text && (
        <>
          <span>{text}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              session.clearMessages();
              setDied(null);
            }}
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
