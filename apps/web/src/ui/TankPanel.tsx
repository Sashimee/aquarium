import {
  creatableBiomeSchema,
  type Biome,
  type CreatableBiome,
  type Tank,
  type TankSize,
  DEFAULT_TANK_SIZE,
  tankSizeSchema,
} from '@aquarium/shared';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  deadFish,
  memorialLine,
  TANK_SIZE_ORDER,
  tankSizeLabel,
  tankSizeShort,
  waterReport,
  type SpeciesNames,
} from '../sync/life';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { doseButtonId, doseOptions } from '../sync/doses';
import { priceOrFree, priceText, tankPrice } from '../sync/economy';
import { checkTankName, suggestTankName } from '../sync/naming';
import { salinityNotice, type SalinityNotice } from '../sync/salinityCare';
import type { SessionState, TankSession } from '../sync/session';
import { useAuth, useBridge } from './context';
import { Co2Control } from './Co2Control';
import { CoralSection } from './Corals';
import { FishCards } from './FishCard';
import { AcceptsGiftsToggle, GiftFishButton, GiftNotice, GiftOffers } from './Gifts';
import { Link } from './screens';
import WaterTest from './WaterTest';
import { ShareSection } from './ShareSection';
import { ShopSections } from './Shop';
import { useSpend } from './spend';
import { QuarantineSection, Treatment } from './Treatment';
import { useActiveTank, useSessionState, useOptionalSession, useSpeciesNames } from './session';

const BIOME_LABEL: Record<Biome, string> = {
  freshwater: 'Freshwater',
  reef: 'Reef',
  cichlid: 'Cichlid',
  blackwater: 'Blackwater',
  mangrove: 'Mangrove',
};

interface Ready {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}

function SignInPrompt() {
  return (
    <div>
      <p>You are looking at the demo tank. It is yours to play with, but nothing in it is saved.</p>
      <p>
        <Link to="/sign-in">Sign in</Link> or <Link to="/sign-up">create an account</Link> with a
        verified email address to keep a tank, choose fish and have them live while you are away.
      </p>
    </div>
  );
}

function Gate({
  noTank,
  children,
}: {
  noTank(session: TankSession, state: SessionState): ReactNode;
  children(ready: Ready): ReactNode;
}) {
  const state = useSessionState();
  const session = useOptionalSession();
  const { user } = useAuth();
  const tank = useActiveTank();

  if (state.phase === 'anonymous') return <SignInPrompt />;
  if (state.phase === 'unverified') {
    return (
      <p>
        {user ? `We sent a link to ${user.email}. ` : ''}Verify your email address to keep a saved
        tank, buy fish and care for them. Until then the demo tank stays available.
      </p>
    );
  }
  if (state.phase === 'loading' || !session) return <p role="status">Loading your tanks.</p>;
  if (state.phase === 'offline') {
    return (
      <div>
        <p role="alert">{state.error}</p>
        <button type="button" onClick={() => void session.load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!tank) return noTank(session, state);
  return children({ session, state, tank });
}

const needTank = (): ReactNode => (
  <p>You have no tank yet. Open My tank at the top to start one.</p>
);

export function TanksPanel({ newTankBiome }: { newTankBiome: CreatableBiome | null }) {
  return (
    <Gate
      noTank={(session, state) => (
        <div>
          <p>You have no tank yet. Start one and add your first fish.</p>
          <NewTankForm
            session={session}
            state={state}
            initialBiome={newTankBiome ?? 'freshwater'}
          />
        </div>
      )}
    >
      {({ session, state, tank }) => (
        <>
          <TankSwitcher session={session} state={state} tank={tank} newTankBiome={newTankBiome} />
          <AcceptsGiftsToggle key={tank.id} session={session} state={state} tank={tank} />
          <GiftOffers session={session} state={state} />
          <Bag session={session} state={state} />
          <ShareSection key={tank.id} session={session} state={state} tank={tank} />
        </>
      )}
    </Gate>
  );
}

export function ShopPanel() {
  return (
    <Gate noTank={needTank}>
      {({ session, state, tank }) => (
        <>
          <ShopSections session={session} state={state} tank={tank} />
          <Bag session={session} state={state} />
        </>
      )}
    </Gate>
  );
}

export function CarePanel({ onShop }: { onShop(): void }) {
  return <Gate noTank={needTank}>{(ready) => <CareSections {...ready} onShop={onShop} />}</Gate>;
}

function CareSections({ session, state, tank, onShop }: Ready & { onShop(): void }) {
  const { interaction } = useBridge();
  const names = useSpeciesNames();
  const water = waterReport(tank.water, tank, state.species);
  return (
    <>
      <Care
        session={session}
        state={state}
        tank={tank}
        water={water}
        salinity={salinityNotice(tank, state.species)}
      />
      <WaterTest
        tank={tank}
        species={state.species}
        onWaterChange={() => session.careAction({ type: 'water_change' })}
        onCo2Off={() => session.setCo2(0)}
      />
      <Co2Control session={session} state={state} tank={tank} onShop={onShop} />
      <CoralSection interaction={interaction} session={session} state={state} tank={tank} />
      <GiftNotice session={session} />
      <FishCards
        fish={tank.fish}
        names={names}
        actions={(fish) => <GiftFishButton session={session} tank={tank} fish={fish} />}
      />
      <Treatment session={session} state={state} tank={tank} />
      <QuarantineSection session={session} state={state} tank={tank} />
      <DeadFish session={session} tank={tank} />
      <Memorial tank={tank} names={names} />
    </>
  );
}

function TankSwitcher({
  session,
  state,
  tank,
  newTankBiome,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
  newTankBiome: CreatableBiome | null;
}) {
  const selectId = useId();
  const [adding, setAdding] = useState(newTankBiome !== null);
  const [renaming, setRenaming] = useState(false);
  return (
    <section aria-labelledby={`${selectId}-h`} className="block">
      <h3 id={`${selectId}-h`}>Tanks</h3>
      <div className="row">
        <label htmlFor={selectId} className="sr-only">
          Active tank
        </label>
        <select
          id={selectId}
          value={tank.id}
          disabled={state.busy}
          onChange={(e) => void session.select(e.target.value)}
        >
          {state.tanks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({BIOME_LABEL[t.biome]}, {tankSizeShort(t.size)})
            </option>
          ))}
        </select>
        <button type="button" aria-expanded={renaming} onClick={() => setRenaming(!renaming)}>
          Rename
        </button>
        <button type="button" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          New tank
        </button>
      </div>
      {renaming && (
        <RenameForm
          key={tank.id}
          current={tank.name}
          busy={state.busy}
          onSubmit={async (name) => {
            const ok = await session.rename(name);
            if (ok) setRenaming(false);
          }}
        />
      )}
      {adding && (
        <NewTankForm
          session={session}
          state={state}
          initialBiome={newTankBiome ?? 'freshwater'}
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function RenameForm({
  current,
  busy,
  onSubmit,
}: {
  current: string;
  busy: boolean;
  onSubmit(name: string): Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkTankName(name);
    if (!checked.ok) return setProblem(checked.message);
    setProblem(null);
    void onSubmit(checked.name);
  };
  return (
    <form onSubmit={submit} className="inline-form" noValidate>
      <label htmlFor={id}>Tank name</label>
      <input
        id={id}
        value={name}
        maxLength={80}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${id}-e` : undefined}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        Save name
      </button>
      {problem && (
        <p id={`${id}-e`} className="field-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

export function NewTankForm({
  session,
  state,
  initialBiome,
  onDone,
}: {
  session: TankSession;
  state: SessionState;
  initialBiome: CreatableBiome;
  onDone?: () => void;
}) {
  const id = useId();
  const [biome, setBiome] = useState<CreatableBiome>(initialBiome);
  const [size, setSize] = useState<TankSize>(DEFAULT_TANK_SIZE);
  const taken = state.tanks.map((t) => t.name);
  const [name, setName] = useState(() => suggestTankName(initialBiome, taken));
  const [problem, setProblem] = useState<string | null>(null);
  const { spend, notice } = useSpend(session, state.balance);
  const price = tankPrice(BUNDLED_ECONOMY, state.tanks, size);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkTankName(name);
    if (!checked.ok) return setProblem(checked.message);
    setProblem(null);
    void spend({
      label: `the tank ${checked.name}`,
      price,
      confirm: true,
      go: async () => {
        const ok = await session.createTank(checked.name, biome, size);
        if (ok) onDone?.();
        return ok;
      },
    });
  };
  return (
    <form onSubmit={submit} className="inline-form" noValidate>
      <label htmlFor={`${id}-b`}>Kind of tank</label>
      <select
        id={`${id}-b`}
        value={biome}
        onChange={(e) => {
          const next = creatableBiomeSchema.parse(e.target.value);
          setBiome(next);
          setName(suggestTankName(next, taken));
        }}
      >
        {creatableBiomeSchema.options.map((b) => (
          <option key={b} value={b}>
            {BIOME_LABEL[b]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-s`}>Size</label>
      <select
        id={`${id}-s`}
        value={size}
        onChange={(e) => setSize(tankSizeSchema.parse(e.target.value))}
      >
        {TANK_SIZE_ORDER.map((s) => (
          <option key={s} value={s}>
            {`${tankSizeLabel(s)}${sizeExtra(s)}`}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-n`}>Tank name</label>
      <input
        id={`${id}-n`}
        value={name}
        maxLength={80}
        aria-invalid={problem !== null}
        onChange={(e) => setName(e.target.value)}
      />
      <p className="hint">
        Price of this tank: {priceOrFree(price, BUNDLED_ECONOMY)}.
        {state.tanks.length > 0 &&
          ' It includes the next tank slot and the size, and it is charged once.'}
      </p>
      <button type="submit" disabled={state.busy}>
        Create tank
      </button>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      {notice}
    </form>
  );
}

function sizeExtra(size: TankSize): string {
  const extra = BUNDLED_ECONOMY.items.tankSizes[size] ?? 0;
  return extra === 0 ? '' : `, size upgrade ${priceText(extra, BUNDLED_ECONOMY)}`;
}

const QUALITY_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor' } as const;

export function Care({
  session,
  state,
  tank,
  water,
  salinity,
}: {
  session: TankSession;
  state: SessionState;
  tank: Tank;
  water: ReturnType<typeof waterReport>;
  salinity: SalinityNotice | null;
}) {
  const id = useId();
  const { spend, notice } = useSpend(session, state.balance);
  const doses = doseOptions(tank, BUNDLED_CHEMISTRY, BUNDLED_ECONOMY);
  const saltDose = doses.find((d) => d.type === 'salt_dose');
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Water and chores</h3>
      <ul className="water">
        <li>Ammonia: {QUALITY_LABEL[water.ammonia]}</li>
        <li>Nitrate: {QUALITY_LABEL[water.nitrate]}</li>
        <li>Algae: {QUALITY_LABEL[water.algae]}</li>
        <li>Leftover food: {QUALITY_LABEL[water.leftoverFood]}</li>
      </ul>
      {salinity && (
        <p className={salinity.severity === 'danger' ? 'field-error' : 'hint'} role="status">
          {salinity.text}
          {saltDose && salinity.direction === 'low' && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => document.getElementById(doseButtonId('salt_dose'))?.focus()}
              >
                Go to {saltDose.label.toLowerCase()}
              </button>
            </>
          )}
        </p>
      )}
      <div className="care-actions">
        <button
          type="button"
          className={water.needsVacuum ? 'primary urgent' : 'primary'}
          disabled={state.busy}
          onClick={() => void session.careAction({ type: 'gravel_vacuum' })}
        >
          Vacuum the gravel{water.needsVacuum ? ' (needed)' : ''}
        </button>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void session.careAction({ type: 'water_change' })}
        >
          Change half the water
        </button>
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void session.careAction({ type: 'algae_scrape' })}
        >
          Scrape the glass
        </button>
      </div>
      {doses.length > 0 && (
        <ul className="shop" aria-label="Water doses">
          {doses.map((dose) => (
            <li key={dose.type}>
              <div>
                <strong>{dose.label}</strong>{' '}
                <span className="price">{priceOrFree(dose.price, BUNDLED_ECONOMY)}</span>
                <p className="hint">{dose.disabledReason ?? dose.hint}</p>
              </div>
              <button
                type="button"
                id={doseButtonId(dose.type)}
                data-action={dose.type}
                disabled={state.busy || dose.disabledReason !== null}
                onClick={() =>
                  void spend({
                    label: dose.label.toLowerCase(),
                    price: dose.price,
                    confirm: true,
                    go: () => session.careAction({ type: dose.type }),
                  })
                }
              >
                {dose.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice}
      <p className="hint">
        Feed from the dock, a little at a time. Uneaten food rots and poisons the water; the gravel
        vacuum removes it.
      </p>
    </section>
  );
}

function Bag({ session, state }: { session: TankSession; state: SessionState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.bagged.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.bagged.length]);
  if (state.bagged.length === 0) return null;
  return (
    <section aria-label="Fish in bags" className="block">
      <h3>Getting used to the water</h3>
      <p className="hint">
        New fish float in a bag so the temperature can even out. They are released on their own.
      </p>
      <ul className="shop">
        {state.bagged.map((b) => (
          <li key={b.fishId}>
            <span>
              {b.name}, {Math.max(0, Math.ceil((b.releaseAtMs - now) / 1000))} s
            </span>
            <button type="button" onClick={() => session.releaseNow(b.fishId)}>
              Release {b.name} now
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeadFish({ session, tank }: { session: TankSession; tank: Tank }) {
  const dead = deadFish(tank);
  if (dead.length === 0) return null;
  return (
    <section aria-label="Fish that have died" className="block loss">
      <h3>Fish that have died</h3>
      <p className="hint">
        Fish float at the surface and shrimp sink to the bottom until you net them. Netting adds
        them to the memorial below.
      </p>
      <ul className="shop">
        {dead.map((f) => (
          <li key={f.id}>
            <span>{f.name}</span>
            <button type="button" onClick={() => session.requestNet(f.id)}>
              Net {f.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Memorial({ tank, names }: { tank: Tank; names: SpeciesNames }) {
  if (tank.memorials.length === 0) return null;
  return (
    <section aria-label="Memorial" className="block">
      <h3>Memorial</h3>
      <ul className="memorial">
        {tank.memorials.map((m) => (
          <li key={m.id}>{memorialLine(m, names)}</li>
        ))}
      </ul>
    </section>
  );
}
