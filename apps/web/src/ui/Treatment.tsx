import {
  playableBiomeSchema,
  type DiseaseKind,
  type Fish,
  type MedicinePotency,
  type Tank,
} from '@aquarium/shared';
import { useId, useState } from 'react';
import { movableFish, moveTargets } from '../sync/moveFish';
import { BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { spendQuestion } from '../sync/economy';
import type { SessionState, TankSession } from '../sync/session';
import {
  blockedText,
  DISEASE_LABEL,
  doseButtonText,
  doseSpend,
  heatTolerantSick,
  emptyHeld,
  type HeldDose,
  listNames,
  liveMedicine,
  medicineLine,
  OVERDOSE_WARNING,
  planDose,
  premiumPrice,
  reconcileHeld,
  severityWord,
  sickFish,
  sickKinds,
  switchWarning,
  SYMPTOMS,
  wantsWaterChange,
} from '../sync/treatment';
import { Dialog } from './Dialog';
import { useSpend } from './spend';

const POTENCIES: readonly MedicinePotency[] = ['standard', 'premium'];

export interface Pending {
  kind: DiseaseKind;
  potency: MedicinePotency;
  warnings: string[];
}

export interface Refusal {
  kind: DiseaseKind;
  message: string;
  waterChange: boolean;
}

interface FishMoverProps {
  session: TankSession;
  state: SessionState;
  tank: Tank;
  fish: Fish;
}

export function Treatment({
  session,
  state,
  tank,
  initialHeld,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
  initialHeld?: HeldDose<Pending, Refusal>;
}) {
  const id = useId();
  const { spend, notice } = useSpend(session, state.balance);
  const [stored, setHeld] = useState<HeldDose<Pending, Refusal>>(
    () => initialHeld ?? emptyHeld(tank.id),
  );
  const held = reconcileHeld(stored, tank.id);
  if (held !== stored) setHeld(held);
  const { pending, refusal } = held;
  const setPending = (next: Pending | null) =>
    setHeld((was) => ({ ...reconcileHeld(was, tank.id), pending: next }));
  const setRefusal = (next: Refusal | null) =>
    setHeld((was) => ({ ...reconcileHeld(was, tank.id), refusal: next }));
  const nowMs = Date.now();
  const kinds = sickKinds(tank);
  const medicine = liveMedicine(tank, nowMs);

  const run = (kind: DiseaseKind, potency: MedicinePotency, warned: boolean) => {
    const go = async () => {
      const outcome = await session.treat(kind, potency);
      if (!outcome.ok && outcome.refusal !== null) {
        setRefusal({
          kind,
          message: outcome.refusal,
          waterChange: wantsWaterChange(outcome.reason),
        });
      }
      return outcome.ok;
    };
    const cost = doseSpend(BUNDLED_ECONOMY, kind, potency, warned);
    if (cost) {
      void spend({ ...cost, go });
    } else {
      void go();
    }
  };

  const start = (kind: DiseaseKind, potency: MedicinePotency) => {
    setRefusal(null);
    const plan = planDose(tank, kind, potency, Date.now());
    if (plan.kind === 'blocked') {
      return setRefusal({
        kind,
        message: blockedText(plan.reason),
        waterChange: plan.reason !== 'nothing-to-treat',
      });
    }
    const warnings = [
      ...(plan.replaces ? [switchWarning(plan.replaces, kind)] : []),
      ...(plan.overdose ? [OVERDOSE_WARNING] : []),
    ];
    if (warnings.length > 0) return setPending({ kind, potency, warnings });
    run(kind, potency, false);
  };

  return (
    <section aria-labelledby={`${id}-h`} className="block treatment">
      <h3 id={`${id}-h`}>Sickness and medicine</h3>
      {kinds.length === 0 && <p className="hint">No fish in this tank look sick.</p>}
      {medicine && <p role="status">{medicineLine(medicine, nowMs)}</p>}
      {kinds.map((kind) => (
        <DiseaseCard
          key={kind}
          kind={kind}
          tank={tank}
          state={state}
          session={session}
          refusal={refusal?.kind === kind ? refusal : null}
          onDose={start}
          onWaterChange={async () => {
            const ok = await session.careAction({ type: 'water_change' });
            if (ok) setRefusal(null);
          }}
        />
      ))}
      {notice}
      {pending && (
        <Dialog title="Before you dose" tone="loss" onClose={() => setPending(null)}>
          <DoseConfirmation
            pending={pending}
            balance={state.balance}
            onConfirm={() => {
              setPending(null);
              run(pending.kind, pending.potency, true);
            }}
            onCancel={() => setPending(null)}
          />
        </Dialog>
      )}
    </section>
  );
}

export function DoseConfirmation({
  pending,
  balance,
  onConfirm,
  onCancel,
}: {
  pending: Pick<Pending, 'kind' | 'potency' | 'warnings'>;
  balance: number | null;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <>
      <PendingDoseWarning pending={pending} balance={balance} />
      <div className="row">
        <button type="button" className="primary" onClick={onConfirm}>
          Dose anyway
        </button>
        <button type="button" onClick={onCancel}>
          Keep things as they are
        </button>
      </div>
    </>
  );
}

export function PendingDoseWarning({
  pending,
  balance,
}: {
  pending: Pick<Pending, 'kind' | 'potency' | 'warnings'>;
  balance: number | null;
}) {
  const cost = doseSpend(BUNDLED_ECONOMY, pending.kind, pending.potency, true);
  return <DoseWarning warnings={pending.warnings} cost={cost} balance={balance} />;
}

export function DoseWarning({
  warnings,
  cost,
  balance,
}: {
  warnings: readonly string[];
  cost: { label: string; price: number } | null;
  balance: number | null;
}) {
  return (
    <>
      {warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
      {cost && <p>{spendQuestion(cost.label, cost.price, balance)}</p>}
    </>
  );
}

function DiseaseCard({
  kind,
  tank,
  state,
  session,
  refusal,
  onDose,
  onWaterChange,
}: {
  kind: DiseaseKind;
  tank: Tank;
  state: SessionState;
  session: TankSession;
  refusal: Refusal | null;
  onDose(kind: DiseaseKind, potency: MedicinePotency): void;
  onWaterChange(): Promise<void>;
}) {
  const fish = sickFish(tank, kind);
  const label = DISEASE_LABEL[kind];
  return (
    <article className="disease" aria-label={`${label} in ${listNames(fish)}`}>
      <h4>{label}</h4>
      <p>
        {listNames(fish)} {fish.length === 1 ? 'shows' : 'show'} {SYMPTOMS[kind]}.
      </p>
      <ul className="hint">
        {fish.map((f) => (
          <li key={f.id}>
            {f.name}: {severityWord(f.disease?.severity ?? 0)}
            <FishMover session={session} state={state} tank={tank} fish={f} />
          </li>
        ))}
      </ul>
      <div className="care-actions">
        {POTENCIES.map((potency) => (
          <button
            key={potency}
            type="button"
            className={potency === 'standard' ? 'primary' : undefined}
            disabled={
              state.busy || (potency === 'premium' && premiumPrice(BUNDLED_ECONOMY, kind) === null)
            }
            onClick={() => onDose(kind, potency)}
          >
            {doseButtonText(BUNDLED_ECONOMY, kind, potency)}
          </button>
        ))}
      </div>
      <p className="hint">
        Premium medicine works in half the time. One dose is right; a second while the first is in
        the water is an overdose.
      </p>
      {kind === 'ich' && <HeatNote tank={tank} state={state} />}
      {refusal && (
        <div role="alert" className="field-error">
          <p>{refusal.message}</p>
          {refusal.waterChange && (
            <button type="button" disabled={state.busy} onClick={() => void onWaterChange()}>
              Change half the water
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function FishMover({ session, state, tank, fish }: FishMoverProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const targets = moveTargets(tank, state.tanks);
  if (targets.length === 0) return null;
  return (
    <span className="fish-mover">
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          disabled={state.busy}
          onClick={() => {
            setRefusal(null);
            void session.move(fish.id, target.id).then((outcome) => {
              if (!outcome.ok) setRefusal(outcome.refusal);
            });
          }}
        >
          Move {fish.name} to {target.name}
        </button>
      ))}
      {refusal && (
        <span role="alert" className="field-error">
          {refusal}
        </span>
      )}
    </span>
  );
}

function HeatNote({ tank, state }: { tank: Tank; state: SessionState }) {
  const tolerant = heatTolerantSick(tank, state.species);
  return (
    <p className="hint">
      {tolerant.length > 0
        ? `Water at 30 °C or warmer also clears ich slowly, but only in fish that tolerate it: ${tolerant.join(' and ')} do. Medicine is faster.`
        : 'Heat is not a cure for these fish. Only a few species, such as betta and discus, tolerate water warm enough to clear ich, and others would suffer in it. Use medicine.'}
    </p>
  );
}

export function QuarantineSection({
  session,
  state,
  tank,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}) {
  const id = useId();
  const [biome, setBiome] = useState<(typeof playableBiomeSchema.options)[number]>(
    tank.biome === 'reef' ? 'reef' : 'freshwater',
  );
  const quarantine = state.tanks.find((t) => t.quarantine);
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Quarantine tank</h3>
      <p className="hint">
        A small tank kept apart, so sick fish can be treated without dosing the whole display tank.
        It is free and does not count toward your six tanks. Move a sick fish in, dose it there, and
        move it back when it is well.
      </p>
      {quarantine === undefined && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void session.createTank('Quarantine', biome, 'nano30', true);
          }}
        >
          <label htmlFor={`${id}-b`}>Kind of water</label>
          <select
            id={`${id}-b`}
            value={biome}
            onChange={(e) => setBiome(playableBiomeSchema.parse(e.target.value))}
          >
            {playableBiomeSchema.options.map((b) => (
              <option key={b} value={b}>
                {b[0]?.toUpperCase()}
                {b.slice(1)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={state.busy}>
            Set up the quarantine tank
          </button>
        </form>
      )}
      {quarantine !== undefined && quarantine.id === tank.id && (
        <>
          <p role="status">You are looking at the quarantine tank.</p>
          <ul className="hint">
            {movableFish(tank)
              .filter((f) => f.disease === null)
              .map((f) => (
                <li key={f.id}>
                  {f.name}
                  <FishMover session={session} state={state} tank={tank} fish={f} />
                </li>
              ))}
          </ul>
        </>
      )}
      {quarantine !== undefined && quarantine.id !== tank.id && (
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void session.select(quarantine.id)}
        >
          Open {quarantine.name}
        </button>
      )}
    </section>
  );
}
