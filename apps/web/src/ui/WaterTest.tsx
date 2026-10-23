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
  type SuitKey,
} from '../sync/waterTest';
import { blackwaterPhGuidance } from '../sync/blackwater';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { doseButtonId, doseOptions } from '../sync/doses';
import { lakeWaterNotes } from '../sync/cichlid';
import { getDip, putDip, type Dip } from './dipStore';

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

export function PhAdvice({
  tank,
  species,
  dip,
}: {
  tank: Tank;
  species: readonly SpeciesSummary[];
  dip: Dip;
}) {
  const reading = dip.strip.ph;
  const known = reading !== undefined && (dip.revealed || dip.guesses.ph !== undefined);
  if (!known) return null;
  const botanicals = doseOptions(tank, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY).find(
    (d) => d.type === 'add_botanicals' && d.disabledReason === null,
  );
  const guidance = blackwaterPhGuidance(
    tank,
    species,
    PADS.ph.steps[reading.stepIndex]?.value ?? reading.value,
    botanicals !== undefined,
  );
  if (!guidance) return null;
  return (
    <p className="ph-advice" data-ph-standing={guidance.standing} role="status">
      {guidance.text}
      {botanicals && guidance.standing === 'too-high' && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => document.getElementById(doseButtonId(botanicals.type))?.focus()}
          >
            Go to {botanicals.label.toLowerCase()}
          </button>
        </>
      )}
    </p>
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

function LakeWater({
  tank,
  species,
  dip,
  onWaterChange,
  onCo2Off,
}: {
  tank: Tank;
  species: readonly SpeciesSummary[];
  dip: Dip;
  onWaterChange: (() => unknown) | undefined;
  onCo2Off: (() => unknown) | undefined;
}) {
  const [pending, setPending] = useState(false);
  const [co2Pending, setCo2Pending] = useState(false);
  const co2Off = () => {
    if (!onCo2Off) return;
    setCo2Pending(true);
    void Promise.resolve(onCo2Off()).finally(() => setCo2Pending(false));
  };
  const change = () => {
    if (!onWaterChange) return;
    setPending(true);
    void Promise.resolve(onWaterChange()).finally(() => setPending(false));
  };
  const known = (id: 'kh' | 'ph') => {
    const reading = dip.strip[id];
    if (!reading || !(dip.revealed || dip.guesses[id] !== undefined)) return undefined;
    return PADS[id].steps[reading.stepIndex]?.value;
  };
  const notes = lakeWaterNotes(tank, species, { kh: known('kh'), ph: known('ph') });
  if (notes.length === 0) return null;
  const buffer = doseOptions(tank, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY).find(
    (d) => d.type === 'buffer_dose' && d.disabledReason === null,
  );
  const canChange = onWaterChange !== undefined && notes.some((n) => n.fix === 'water-change');
  return (
    <div className="lake-notes" data-testid="lake-notes">
      <div role="status">
        <ul>
          {notes.map((n) => (
            <li
              key={n.metric}
              className={n.level === 'watch' ? 'hint' : 'warning'}
              data-level={n.level}
              data-metric={n.metric}
            >
              {n.text}
              {buffer && n.metric === 'kh' && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => document.getElementById(doseButtonId(buffer.type))?.focus()}
                  >
                    Go to {buffer.label.toLowerCase()}
                  </button>
                </>
              )}
              {onCo2Off && n.metric === 'ph' && n.fix === 'no-fix' && (
                <>
                  {' '}
                  <button
                    type="button"
                    data-action="co2-off"
                    disabled={co2Pending}
                    onClick={co2Off}
                  >
                    Turn the CO₂ off
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      {canChange && (
        <button type="button" data-action="lake-water-change" disabled={pending} onClick={change}>
          Change half the water
        </button>
      )}
    </div>
  );
}

export default function WaterTest({
  tank,
  species,
  onWaterChange,
  onCo2Off,
}: {
  tank: Tank;
  species: readonly SpeciesSummary[];
  onWaterChange?: () => unknown;
  onCo2Off?: () => unknown;
}) {
  const id = useId();
  const [dip, setDip] = useState<Dip | null>(() => getDip(tank.id));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setDip(getDip(tank.id));
  }, [tank.id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const store = (next: Dip) => {
    putDip(tank.id, next);
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
          {tank.biome === 'cichlid' && (
            <LakeWater
              tank={tank}
              species={species}
              dip={dip}
              onWaterChange={onWaterChange}
              onCo2Off={onCo2Off}
            />
          )}
          <PhAdvice tank={tank} species={species} dip={dip} />
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
