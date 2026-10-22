import type { Tank } from '@aquarium/shared';
import { useId } from 'react';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { co2Choices } from '../sync/equipment';
import type { SessionState, TankSession } from '../sync/session';

export function Co2Control({
  session,
  state,
  tank,
  onShop,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
  onShop(): void;
}) {
  const id = useId();
  const choices = co2Choices(tank, BUNDLED_ECONOMY);
  const involved =
    tank.equipment.co2.tier > 0 ||
    tank.co2OwnedTier > 0 ||
    choices.some((c) => c.tier > 0 && c.state !== 'refused');
  if (!involved) return null;
  const refused = choices.find((c) => c.state === 'refused');
  return (
    <section aria-labelledby={`${id}-h`} className="block co2-control" data-testid="co2-control">
      <h3 id={`${id}-h`}>CO₂</h3>
      <p className="hint">
        {tank.equipment.co2.tier === 0
          ? 'The CO₂ is off.'
          : `The CO₂ runs at tier ${tank.equipment.co2.tier}.`}{' '}
        Turning it down or off is free, and so is switching back to a tier you already bought.
      </p>
      <div className="care-actions" role="group" aria-labelledby={`${id}-h`}>
        {choices.map((c) => {
          const note = `${id}-${c.tier}`;
          if (c.state === 'shop') {
            return (
              <button
                key={c.tier}
                type="button"
                data-co2-tier={c.tier}
                data-co2-state="shop"
                aria-label={`${c.label}: not bought yet, open the shop`}
                onClick={onShop}
              >
                {c.label} (shop)
              </button>
            );
          }
          return (
            <button
              key={c.tier}
              type="button"
              data-co2-tier={c.tier}
              data-co2-state={c.state}
              aria-pressed={c.state === 'running'}
              aria-describedby={c.reason ? note : undefined}
              disabled={c.state === 'refused' || (c.state === 'running' ? false : state.busy)}
              onClick={() => {
                if (c.state === 'available') void session.setCo2(c.tier);
              }}
            >
              {c.label}
              {c.reason && (
                <span id={note} className="sr-only">
                  {c.reason}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {refused?.reason && <p className="hint">{refused.reason}</p>}
    </section>
  );
}
