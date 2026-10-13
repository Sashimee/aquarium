import { describeAway, netPrompt } from '../sync/life';
import { Dialog } from './Dialog';
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

/** The one confirm step before netting, whether the tap came from the tank or from the panel. */
export function NetDialog() {
  const session = useTankSession();
  const state = useSessionState();
  const names = useSpeciesNames();
  const tank = useActiveTank();
  const fish = tank?.fish.find((f) => f.id === state.pendingNet && f.status === 'dead');
  if (!fish) return null;

  const step = netPrompt(fish, names);
  return (
    <Dialog title={`Net ${fish.name}?`} tone="loss" onClose={() => session.cancelNet()}>
      <p>{step.prompt}</p>
      <div className="row">
        <button type="button" disabled={state.busy} onClick={() => void session.confirmNet()}>
          {step.confirmLabel}
        </button>
        <button type="button" onClick={() => session.cancelNet()}>
          Not yet
        </button>
      </div>
    </Dialog>
  );
}

export default function LifeDialogs({ onReview }: { onReview(): void }) {
  return (
    <>
      <AwayDialog onReview={onReview} />
      <NetDialog />
    </>
  );
}
