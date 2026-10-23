import { useEffect, useState } from 'react';
import type { Plant } from '@aquarium/shared';
import {
  clampTrimSize,
  describePlantSize,
  followTrimTarget,
  plantLabel,
  trimRange,
  trimRefusalShown,
  type TrimRange,
} from '../sync/plantTrim';
import { useBridge } from './context';
import { Dialog } from './Dialog';
import { useActiveTank, useOptionalSession, useSessionState } from './session';

export function TrimBody({
  plant,
  range,
  busy,
  refusal,
  onTrim,
  onCancel,
}: {
  plant: Plant;
  range: TrimRange;
  busy: boolean;
  refusal: string | null;
  onTrim(size: number): void;
  onCancel(): void;
}) {
  const [size, setSize] = useState(range.suggested);
  const chosen = clampTrimSize(range, size);
  const percent = `${Math.round(chosen * 100)}%`;
  return (
    <>
      <p>{`This ${plantLabel(plant.assetId)} is ${describePlantSize(plant)}.`}</p>
      <label htmlFor="trim-size">{`Cut it back to ${percent}`}</label>
      <input
        id="trim-size"
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={chosen}
        aria-valuetext={percent}
        onChange={(e) => setSize(e.target.valueAsNumber)}
      />
      <p className="hint">
        The cut leaves the tank; the water stays as it is. The plant grows back.
      </p>
      {refusal && (
        <p role="alert" className="error">
          {refusal}
        </p>
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => onTrim(chosen)}>
          Trim to {percent}
        </button>
        <button type="button" onClick={onCancel}>
          Not now
        </button>
      </div>
    </>
  );
}

export default function TrimDialog() {
  const { interaction } = useBridge();
  const session = useOptionalSession();
  const state = useSessionState();
  const tank = useActiveTank();
  const [key, setKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(
    () =>
      followTrimTarget(interaction, (next) => {
        setRefusal(null);
        setKey(next);
      }),
    [interaction],
  );

  const plant = key === null ? undefined : tank?.plants?.find((p) => p.key === key);
  if (!session || !plant) return null;

  const close = () => setKey(null);
  const range = trimRange(plant);
  const label = plantLabel(plant.assetId);
  return (
    <Dialog title={`Trim the ${label}?`} onClose={close}>
      {range ? (
        <TrimBody
          key={plant.key}
          plant={plant}
          range={range}
          busy={state.busy}
          refusal={refusal}
          onCancel={close}
          onTrim={(size) =>
            void session.trimPlant(plant.key, size).then((outcome) => {
              const shown = trimRefusalShown(outcome, session.getState().error);
              if (shown === null) close();
              else setRefusal(shown);
            })
          }
        />
      ) : (
        <>
          <p>{`This ${label} is as small as it can be cut back. Let it grow first.`}</p>
          <div className="row">
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
