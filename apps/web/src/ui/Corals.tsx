import type { Tank } from '@aquarium/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { BUNDLED_CORALS } from '../sync/bundledCorals';
import { describeBleach, fragChoices, lampWarning, reefIsBleaching } from '../sync/coralCare';
import type { SessionState, TankSession } from '../sync/session';

const REANNOUNCE_MS = 50;

export function CoralSection(props: CoralSectionProps) {
  return <CoralSectionBody key={props.tank.id} {...props} />;
}

interface CoralSectionProps {
  interaction: EventBus<InteractionEvents>;
  session: TankSession;
  state: SessionState;
  tank: Tank;
}

function CoralSectionBody({ interaction, session, state, tank }: CoralSectionProps) {
  const id = useId();
  const [picked, setPicked] = useState<{ key: string; seq: number } | null>(null);
  const [said, setSaid] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const seq = useRef(0);
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const choices = fragChoices(tank.corals, BUNDLED_CORALS.params.fragMaxBleach);
  const pickedLabel = choices.find((c) => c.coral.key === picked?.key)?.label ?? null;

  useEffect(
    () =>
      interaction.on('coral:picked', ({ key }) => {
        seq.current += 1;
        setPicked(key === null ? null : { key, seq: seq.current });
      }),
    [interaction],
  );

  useEffect(() => {
    setSaid('');
    if (!picked || pickedLabel === null) return undefined;
    rows.current.get(picked.key)?.scrollIntoView?.({ block: 'nearest' });
    // A live region only speaks on a change, so a repeat tap empties it first.
    const timer = setTimeout(() => setSaid(`Selected the ${pickedLabel}.`), REANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [picked, pickedLabel]);

  if (choices.length === 0) return null;
  const warning = lampWarning(tank.corals, tank.equipment.light, BUNDLED_CORALS);
  const bleaching = reefIsBleaching(tank.corals);
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Corals</h3>
      {warning && (
        <p role="alert" className="error">
          {warning}
        </p>
      )}
      {bleaching && !warning && (
        <p role="status" className="hint">
          Some corals are bleaching. Check the water test for temperature, salinity, hardness and
          pH, and keep the lamp gentle. They recover slowly once the water is right.
        </p>
      )}
      <ul className="shop">
        {choices.map(({ coral, label, enabled, why }) => (
          <li
            key={coral.key}
            aria-current={picked?.key === coral.key ? 'true' : undefined}
            ref={(row) => {
              if (row) rows.current.set(coral.key, row);
              else rows.current.delete(coral.key);
            }}
          >
            <span>
              {label}: {Math.round(coral.size * 100)}% size, {describeBleach(coral.bleach)}
              {why && <span className="hint"> {why}</span>}
            </span>
            <button
              type="button"
              disabled={state.busy || !enabled}
              aria-label={`Cut a fragment from the ${label}`}
              onClick={() =>
                void session.fragCoral(coral.key).then((outcome) => {
                  setRefusal(
                    outcome.refusal === null ? null : { key: coral.key, text: outcome.refusal },
                  );
                })
              }
            >
              Cut a fragment
            </button>
            {refusal?.key === coral.key && (
              <p role="alert" className="error">
                {refusal.text}
              </p>
            )}
          </li>
        ))}
      </ul>
      <p role="status" className="hint">
        {said}
      </p>
      <p className="hint">
        Tap a coral in the tank to find it here. A fragment starts small on the substrate nearby and
        grows on its own. Cutting takes size from the colony.
      </p>
    </section>
  );
}
