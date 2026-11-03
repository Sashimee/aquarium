import type { Tank } from '@aquarium/shared';
import { useEffect, useId, useState } from 'react';
import { BUNDLED_CHEMISTRY } from '../sync/bundledEconomy';
import type { SessionState, TankSession } from '../sync/session';

export type HeaterMode = 'installed' | 'removed' | 'none';

export function heaterMode(tank: Pick<Tank, 'equipment' | 'heaterOwnedTier'>): HeaterMode {
  if (tank.equipment.heater.tier > 0) return 'installed';
  return tank.heaterOwnedTier > 0 ? 'removed' : 'none';
}

export function HeaterControl({
  session,
  state,
  tank,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}) {
  const id = useId();
  const mode = heaterMode(tank);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [mode, tank.id]);
  if (mode === 'none') return null;
  const roomC = BUNDLED_CHEMISTRY.temperature.roomC;
  return (
    <section
      aria-labelledby={`${id}-h`}
      className="block heater-control"
      data-testid="heater-control"
    >
      <h3 id={`${id}-h`}>Heater</h3>
      {mode === 'installed' ? (
        <>
          <p className="hint">
            The heater runs at tier {tank.equipment.heater.tier}. You can unplug it and put it back
            later at no cost.
          </p>
          {confirming ? (
            <div className="warning" role="alert">
              <p>
                Remove the heater? Without it the water cools to room temperature, about {roomC} °C,
                and warm-water fish can get stressed and sick.
              </p>
              <div className="care-actions">
                <button
                  type="button"
                  data-heater-action="confirm-remove"
                  disabled={state.busy}
                  onClick={() => void session.removeHeater()}
                >
                  Remove heater
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="care-actions">
              <button
                type="button"
                data-heater-action="remove"
                disabled={state.busy}
                onClick={() => setConfirming(true)}
              >
                Remove heater
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">
            The heater is out of the tank and the water drifts toward {roomC} °C. Your tier{' '}
            {tank.heaterOwnedTier} heater goes back in for free.
          </p>
          <div className="care-actions">
            <button
              type="button"
              data-heater-action="reinstall"
              disabled={state.busy}
              onClick={() => void session.reinstallHeater()}
            >
              Reinstall heater (free)
            </button>
          </div>
        </>
      )}
    </section>
  );
}
