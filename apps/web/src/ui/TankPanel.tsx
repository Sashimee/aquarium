import {
  playableBiomeSchema,
  type Biome,
  type PlayableBiome,
  type SpeciesSummary,
  type Tank,
  type TankSize,
  DEFAULT_TANK_SIZE,
  tankSizeSchema,
} from '@aquarium/shared';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  canBuy,
  deadFish,
  memorialLine,
  TANK_SIZE_ORDER,
  tankCapacity,
  tankSizeLabel,
  tankSizeShort,
  waterReport,
  type SpeciesNames,
} from '../sync/life';
import { checkFishName, checkTankName, suggestFishName, suggestTankName } from '../sync/naming';
import type { SessionState, TankSession } from '../sync/session';
import { useAuth } from './context';
import { FishCards } from './FishCard';
import { Link } from './screens';
import WaterTest from './WaterTest';
import { ShareSection } from './ShareSection';
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

export function TanksPanel({ newTankBiome }: { newTankBiome: PlayableBiome | null }) {
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
          <Shop session={session} state={state} tank={tank} />
          <Bag session={session} state={state} />
        </>
      )}
    </Gate>
  );
}

export function CarePanel() {
  return <Gate noTank={needTank}>{(ready) => <CareSections {...ready} />}</Gate>;
}

function CareSections({ session, state, tank }: Ready) {
  const names = useSpeciesNames();
  const water = waterReport(tank.water, tank, state.species);
  return (
    <>
      <Care session={session} state={state} water={water} />
      <WaterTest tank={tank} species={state.species} />
      <FishCards fish={tank.fish} names={names} />
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
  newTankBiome: PlayableBiome | null;
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

function NewTankForm({
  session,
  state,
  initialBiome,
  onDone,
}: {
  session: TankSession;
  state: SessionState;
  initialBiome: PlayableBiome;
  onDone?: () => void;
}) {
  const id = useId();
  const [biome, setBiome] = useState<PlayableBiome>(initialBiome);
  const [size, setSize] = useState<TankSize>(DEFAULT_TANK_SIZE);
  const taken = state.tanks.map((t) => t.name);
  const [name, setName] = useState(() => suggestTankName(initialBiome, taken));
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkTankName(name);
    if (!checked.ok) return setProblem(checked.message);
    setProblem(null);
    void session.createTank(checked.name, biome, size).then((ok) => {
      if (ok) onDone?.();
    });
  };
  return (
    <form onSubmit={submit} className="inline-form" noValidate>
      <label htmlFor={`${id}-b`}>Kind of tank</label>
      <select
        id={`${id}-b`}
        value={biome}
        onChange={(e) => {
          const next = playableBiomeSchema.parse(e.target.value);
          setBiome(next);
          setName(suggestTankName(next, taken));
        }}
      >
        {playableBiomeSchema.options.map((b) => (
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
            {tankSizeLabel(s)}
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
      <button type="submit" disabled={state.busy}>
        Create tank
      </button>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

const QUALITY_LABEL = { good: 'Good', fair: 'Fair', poor: 'Poor' } as const;

function Care({
  session,
  state,
  water,
}: {
  session: TankSession;
  state: SessionState;
  water: ReturnType<typeof waterReport>;
}) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Water and chores</h3>
      <ul className="water">
        <li>Ammonia: {QUALITY_LABEL[water.ammonia]}</li>
        <li>Nitrate: {QUALITY_LABEL[water.nitrate]}</li>
        <li>Algae: {QUALITY_LABEL[water.algae]}</li>
        <li>Leftover food: {QUALITY_LABEL[water.leftoverFood]}</li>
      </ul>
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
      <p className="hint">
        Feed from the dock, a little at a time. Uneaten food rots and poisons the water; the gravel
        vacuum removes it.
      </p>
    </section>
  );
}

function Shop({ session, state, tank }: { session: TankSession; state: SessionState; tank: Tank }) {
  const id = useId();
  const cap = tankCapacity(tank, state.species);
  const offered = state.species.filter((s) => s.biome === tank.biome);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const taken = tank.fish.map((f) => f.name);
  const suggestion = suggestFishName(taken, tank.fish.length);

  useEffect(() => setProblem(null), [name]);

  const buy = (species: SpeciesSummary) => {
    const checked = checkFishName(name.trim() === '' ? suggestion : name);
    if (!checked.ok) return setProblem(checked.message);
    void session.buy(species.id, checked.name).then((ok) => {
      if (ok) setName('');
    });
  };

  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Choose a fish</h3>
      <p>
        <progress
          max={cap.capacity}
          value={Math.min(cap.usedBioload, cap.capacity)}
          aria-label="Tank load"
        />{' '}
        {cap.livingFish} of {cap.maxFish} animals, load {cap.usedBioload.toFixed(1)} of{' '}
        {cap.capacity}
      </p>
      <label htmlFor={`${id}-n`}>Name for the new fish</label>
      <input
        id={`${id}-n`}
        value={name}
        placeholder={suggestion}
        maxLength={60}
        aria-invalid={problem !== null}
        onChange={(e) => setName(e.target.value)}
      />
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <ul className="shop">
        {offered.map((s) => {
          const verdict = canBuy(tank, s, state.species);
          return (
            <li key={s.id}>
              <div>
                <strong>{s.commonName}</strong> <em>{s.scientificName}</em>
                {!verdict.ok && (
                  <p id={`${id}-${s.id}`} className="hint">
                    {verdict.reason}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={state.busy || !verdict.ok}
                aria-describedby={verdict.ok ? undefined : `${id}-${s.id}`}
                onClick={() => buy(s)}
              >
                Add
              </button>
            </li>
          );
        })}
      </ul>
      {offered.length === 0 && <p>No fish are on offer for this kind of tank yet.</p>}
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
