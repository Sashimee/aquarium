import type { SpeciesSummary, Tank } from '@aquarium/shared';
import { useEffect, useId, useState } from 'react';
import {
  HAZARD_LABEL,
  PADS,
  SUIT_LABEL,
  describeReading,
  dipStrip,
  formatStep,
  gradeGuess,
  padsFor,
  rawValues,
  suitability,
  verdictHazard,
  type PadId,
  type PadReading,
  type StripResult,
  type SuitKey,
} from '../sync/waterTest';

interface Dip {
  at: number;
  strip: StripResult;
  temperatureC: number;
  guesses: Partial<Record<PadId, number>>;
  revealed: boolean;
}

const MAX_REMEMBERED_DIPS = 20;
const lastDip = new Map<string, Dip>();

const SUIT_KEY: Partial<Record<PadId, SuitKey>> = { ph: 'ph', kh: 'kh', salinity: 'salinity' };

function minutesAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

function Swatch({ colour, label }: { colour: string; label?: string }) {
  return (
    <span
      className="swatch"
      style={{ background: colour }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

function Pad({
  id,
  reading,
  guess,
  onGuess,
}: {
  id: PadId;
  reading: PadReading;
  guess: number | undefined;
  onGuess(index: number): void;
}) {
  const spec = PADS[id];
  const group = useId();
  const grade = guess === undefined ? null : gradeGuess(reading, guess);
  return (
    <fieldset className="pad" data-pad={id}>
      <legend>{spec.label}</legend>
      <div className="pad-row">
        <span
          className="pad-strip"
          data-testid={`pad-${id}`}
          style={{ background: reading.colour }}
        >
          <span className="sr-only">{spec.label} pad, colour from the dipped strip</span>
        </span>
        <div
          className="chart"
          role="radiogroup"
          aria-label={`${spec.label}: which chart colour matches the pad?`}
        >
          {spec.steps.map((s, i) => (
            <label key={s.value} className={guess === i ? 'chart-step chosen' : 'chart-step'}>
              <input
                type="radio"
                name={`${group}-${id}`}
                checked={guess === i}
                onChange={() => onGuess(i)}
              />
              <Swatch colour={s.colour} />
              <span>{formatStep(id, i)}</span>
            </label>
          ))}
        </div>
      </div>
      {grade && (
        <p className="pad-result" role="status">
          {grade === 'exact' ? 'Spot on' : grade === 'close' ? 'Close' : 'Not quite'}:{' '}
          {describeReading(reading)}.
        </p>
      )}
    </fieldset>
  );
}

function Readings({
  tank,
  species,
  dip,
  now,
}: {
  tank: Tank;
  species: readonly SpeciesSummary[];
  dip: Dip;
  now: number;
}) {
  const temperatureFit = suitability(tank, species, 'temperatureC', dip.temperatureC);
  return (
    <table className="readings" aria-label="Chemistry readings">
      <caption>Tested {minutesAgo(dip.at, now)}</caption>
      <thead>
        <tr>
          <th scope="col">Test</th>
          <th scope="col">Reading</th>
          <th scope="col">Verdict</th>
        </tr>
      </thead>
      <tbody>
        {padsFor(tank.biome).map((id) => {
          const reading = dip.strip[id];
          const known = reading !== undefined && (dip.revealed || dip.guesses[id] !== undefined);
          const suitKey = SUIT_KEY[id];
          const hazard = reading ? verdictHazard(tank, species, reading) : 'safe';
          const verdict = !reading
            ? 'No reading'
            : !known
              ? 'Read the pad first'
              : suitKey
                ? SUIT_LABEL[suitability(tank, species, suitKey, reading.value)]
                : HAZARD_LABEL[hazard];
          return (
            <tr key={id} data-reading={id} data-hazard={known ? hazard : 'unread'}>
              <th scope="row">{PADS[id].label}</th>
              <td>{known ? describeReading(reading) : 'Not read yet'}</td>
              <td>
                {known && hazard !== 'safe' && !suitKey ? '! ' : ''}
                {verdict}
              </td>
            </tr>
          );
        })}
        <tr data-reading="temperature">
          <th scope="row">Temperature</th>
          <td>{dip.temperatureC.toFixed(1)} °C</td>
          <td>{SUIT_LABEL[temperatureFit]}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function WaterTest({
  tank,
  species,
}: {
  tank: Tank;
  species: readonly SpeciesSummary[];
}) {
  const id = useId();
  const [dip, setDip] = useState<Dip | null>(() => lastDip.get(tank.id) ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setDip(lastDip.get(tank.id) ?? null);
  }, [tank.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const store = (next: Dip) => {
    lastDip.delete(tank.id);
    lastDip.set(tank.id, next);
    const oldest = lastDip.keys().next().value;
    if (lastDip.size > MAX_REMEMBERED_DIPS && oldest !== undefined) lastDip.delete(oldest);
    setDip(next);
  };

  const dipNow = () => {
    const at = Date.now();
    setNow(at);
    store({
      at,
      strip: dipStrip(tank.biome, rawValues(tank)),
      temperatureC: tank.chemistry.temperatureC,
      guesses: {},
      revealed: false,
    });
  };

  return (
    <section aria-labelledby={`${id}-h`} className="block test-kit">
      <h3 id={`${id}-h`}>Water test kit</h3>
      <p className="hint">
        Dip a strip, then match each pad to the colour chart. Every colour has its number printed
        beside it.
      </p>
      <div className="care-actions">
        <button type="button" className="primary" data-action="dip-strip" onClick={dipNow}>
          {dip ? 'Dip a fresh strip' : 'Dip a test strip'}
        </button>
      </div>
      {dip && (
        <>
          <Readings tank={tank} species={species} dip={dip} now={now} />
          {!dip.revealed && (
            <button type="button" onClick={() => store({ ...dip, revealed: true })}>
              Show all readings
            </button>
          )}
          {padsFor(tank.biome).map((padId) => {
            const reading = dip.strip[padId];
            if (!reading) return null;
            return (
              <Pad
                key={`${dip.at}-${padId}`}
                id={padId}
                reading={reading}
                guess={dip.guesses[padId]}
                onGuess={(index) => store({ ...dip, guesses: { ...dip.guesses, [padId]: index } })}
              />
            );
          })}
        </>
      )}
    </section>
  );
}
