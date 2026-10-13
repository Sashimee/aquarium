import { useEffect, useState } from 'react';
import { describeAway } from '../sync/life';
import { Dialog } from './Dialog';
import { useBridge } from './context';
import { useActiveTank, useSessionState, useSpeciesNames, useTankSession } from './session';

/** The server's offline catch-up, shown once per load for the tank that is on screen. */
export function AwayDialog({ onReview }: { onReview(): void }) {
  const session = useTankSession();
  const state = useSessionState();
  const names = useSpeciesNames();
  const tank = useActiveTank();
  const away = tank ? state.awayByTank[tank.id] : undefined;
  if (!tank || !away) return null;

  const report = describeAway(away, names);
  const needsNet = tank.fish.some((f) => f.status === 'dead');
  const close = () => session.dismissAway(tank.id);
  return (
    <Dialog title={report.title} tone={report.tone} onClose={close}>
      <p className="hint">{tank.name}</p>
      {report.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {report.deaths.length > 0 && (
        <ul className="loss-list">
          {report.deaths.map((d) => (
            <li key={d.fishId}>
              {d.sentence} {d.advice}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        {needsNet && (
          <button
            type="button"
            onClick={() => {
              close();
              onReview();
            }}
          >
            See the fish to net
          </button>
        )}
        <button type="button" onClick={close}>
          Continue
        </button>
      </div>
    </Dialog>
  );
}

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
