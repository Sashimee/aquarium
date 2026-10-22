import type { Tank } from '@aquarium/shared';
import { useId, useState } from 'react';
import { BUNDLED_CORALS } from '../sync/bundledCorals';
import { describeBleach, fragChoices, lampWarning, reefIsBleaching } from '../sync/coralCare';
import type { SessionState, TankSession } from '../sync/session';

export function CoralSection(props: CoralSectionProps) {
  return <CoralSectionBody key={props.tank.id} {...props} />;
}

interface CoralSectionProps {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}

function CoralSectionBody({ session, state, tank }: CoralSectionProps) {
  const id = useId();
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const choices = fragChoices(tank.corals, BUNDLED_CORALS.params.fragMaxBleach);
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
          <li key={coral.key}>
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
      <p className="hint">
        A fragment starts small on the substrate nearby and grows on its own. Cutting takes size
        from the colony.
      </p>
    </section>
  );
}
