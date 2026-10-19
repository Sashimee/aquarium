import { useState } from 'react';
import { describeAway, netPrompt } from '../sync/life';
import { Dialog } from './Dialog';
import { ReplayView } from './ReplayView';
import { useActiveTank, useSessionState, useSpeciesNames, useTankSession } from './session';

export function AwayBody({
  tankName,
  report,
  canReplay,
  needsNet,
  onWatch,
  onNet,
  onContinue,
}: {
  tankName: string;
  report: ReturnType<typeof describeAway>;
  canReplay: boolean;
  needsNet: boolean;
  onWatch(): void;
  onNet(): void;
  onContinue(): void;
}) {
  return (
    <>
      <p className="hint">{tankName}</p>
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
        {canReplay && (
          <button type="button" onClick={onWatch}>
            Watch what happened
          </button>
        )}
        {needsNet && (
          <button type="button" onClick={onNet}>
            See the fish to net
          </button>
        )}
        <button type="button" onClick={onContinue}>
          Continue
        </button>
      </div>
    </>
  );
}

/** The server's offline catch-up, shown once per load for the tank that is on screen. */
export function AwayDialog({ onReview }: { onReview(): void }) {
  const session = useTankSession();
  const state = useSessionState();
  const names = useSpeciesNames();
  const tank = useActiveTank();
  const away = tank ? state.awayByTank[tank.id] : undefined;
  // Keyed by tank so switching tanks drops a replay that belonged to the previous one.
  const [replayingTankId, setReplayingTankId] = useState<string | null>(null);
  if (!tank || !away) return null;

  const close = () => session.dismissAway(tank.id);
  if (replayingTankId === tank.id && away.fromAt) {
    return (
      <ReplayView
        tank={tank}
        away={away}
        since={away.fromAt}
        onSkip={() => setReplayingTankId(null)}
      />
    );
  }
  const report = describeAway(away, names);
  return (
    <Dialog title={report.title} tone={report.tone} onClose={close}>
      <AwayBody
        tankName={tank.name}
        report={report}
        canReplay={away.fromAt !== undefined}
        needsNet={tank.fish.some((f) => f.status === 'dead')}
        onWatch={() => setReplayingTankId(tank.id)}
        onNet={() => {
          close();
          onReview();
        }}
        onContinue={close}
      />
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
