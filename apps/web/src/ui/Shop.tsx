import {
  DECOR_ASSET_IDS,
  DEFAULT_BACKGROUND_ID,
  isPlayableBiome,
  type PurchasableStage,
  type SpeciesSummary,
  type Tank,
} from '@aquarium/shared';
import { useEffect, useId, useState } from 'react';
import { BUNDLED_CHEMISTRY, BUNDLED_ECONOMY } from '../sync/bundledEconomy';
import { euroText, heaterWarning, priceText, speciesPrice } from '../sync/economy';
import { equipmentNote } from '../sync/blackwater';
import { chooseEquipment, deviceOffers, equipmentRef, type DeviceOffer } from '../sync/equipment';
import { checkLamp, clockText, hourOptions, lampSummary, localOffsetMinutes } from '../sync/lamp';
import { canBuy, tankCapacity } from '../sync/life';
import { fishNeedsConfirm } from '../sync/spending';
import { checkFishName, suggestFishName } from '../sync/naming';
import type { SessionState, TankSession } from '../sync/session';
import { backgroundOptions } from './backgroundTitles';
import { useSpend, type SpendRequest } from './spend';

const economy = BUNDLED_ECONOMY;

interface ShopProps {
  session: TankSession;
  state: SessionState;
  tank: Tank;
}

function Price({ pearls }: { pearls: number }) {
  return <span className="price">{priceText(pearls, economy)}</span>;
}

const STAGES: readonly { stage: PurchasableStage; label: string }[] = [
  { stage: 'juvenile', label: 'Juvenile' },
  { stage: 'adult', label: 'Adult' },
];

function growsUp(species: SpeciesSummary): string | null {
  const days = species.breeding.fryGrowth?.adultAfterDays;
  return days === undefined ? null : ` It grows up in about ${Math.round(days)} days.`;
}

export function ShopSections({ session, state, tank }: ShopProps) {
  const { spend, notice } = useSpend(session, state.balance);
  useEffect(() => {
    void session.refreshWallet();
    const again = () => void session.refreshWallet();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [session]);
  return (
    <>
      {notice}
      <FishShop session={session} state={state} tank={tank} spend={spend} />
      <EquipmentShop session={session} state={state} tank={tank} spend={spend} />
      <LampControl session={session} state={state} tank={tank} />
      <SuppliesShop session={session} state={state} spend={spend} />
      <PieceShop session={session} state={state} tank={tank} spend={spend} />
    </>
  );
}

type Spend = (request: SpendRequest) => Promise<void>;

function FishShop({ session, state, tank, spend }: ShopProps & { spend: Spend }) {
  const id = useId();
  const cap = tankCapacity(tank, state.species);
  const offered = state.species.filter((s) => s.biome === tank.biome);
  const [stage, setStage] = useState<PurchasableStage>('juvenile');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const taken = tank.fish.map((f) => f.name);
  const suggestion = suggestFishName(taken, tank.fish.length);

  useEffect(() => setProblem(null), [name]);
  useEffect(() => setConfirming(null), [stage, tank.id, tank.equipment.heater.tier]);

  const buy = (species: SpeciesSummary) => {
    const checked = checkFishName(name.trim() === '' ? suggestion : name);
    if (!checked.ok) return setProblem(checked.message);
    const price = speciesPrice(economy, species.id, stage);
    if (price === undefined) return setProblem(`${species.commonName} is not for sale.`);
    if (
      heaterWarning(tank, species, BUNDLED_CHEMISTRY.temperature.roomC) &&
      confirming !== species.id
    ) {
      return setConfirming(species.id);
    }
    setConfirming(null);
    void spend({
      label: species.commonName,
      price,
      confirm: fishNeedsConfirm(stage, price),
      go: async () => {
        const ok = await session.buy(species.id, checked.name, stage);
        if (ok) setName('');
        return ok;
      },
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
      <div role="group" aria-label="Size when bought" className="segmented">
        {STAGES.map((s) => (
          <button
            key={s.stage}
            type="button"
            aria-pressed={stage === s.stage}
            onClick={() => setStage(s.stage)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="hint">
        A juvenile is smaller and costs less, and grows into an adult. An adult costs more and
        arrives at full size and colour.
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
          const price = speciesPrice(economy, s.id, stage);
          const warning = heaterWarning(tank, s, BUNDLED_CHEMISTRY.temperature.roomC);
          const asking = confirming === s.id && warning !== null;
          return (
            <li key={s.id}>
              <div>
                <strong>{s.commonName}</strong> <em>{s.scientificName}</em>
                {price !== undefined && (
                  <p className="hint">
                    <Price pearls={price} />
                    {stage === 'juvenile' ? growsUp(s) : null}
                  </p>
                )}
                {!verdict.ok && (
                  <p id={`${id}-${s.id}`} className="hint">
                    {verdict.reason}
                  </p>
                )}
                {asking && (
                  <p id={`${id}-${s.id}-w`} className="warning" role="alert">
                    {warning}
                  </p>
                )}
              </div>
              <div className="row">
                <button
                  type="button"
                  disabled={state.busy || !verdict.ok || price === undefined}
                  aria-describedby={
                    verdict.ok ? (asking ? `${id}-${s.id}-w` : undefined) : `${id}-${s.id}`
                  }
                  onClick={() => buy(s)}
                >
                  {asking ? 'Add anyway' : 'Add'}
                </button>
                {asking && (
                  <button type="button" onClick={() => setConfirming(null)}>
                    Not now
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {offered.length === 0 && <p>No fish are on offer for this kind of tank yet.</p>}
    </section>
  );
}

function DeviceRow({
  offer,
  tank,
  busy,
  onBuy,
}: {
  offer: DeviceOffer;
  tank: Tank;
  busy: boolean;
  onBuy(tier: number): void;
}) {
  const id = useId();
  return (
    <li>
      <h4 id={id}>{offer.label}</h4>
      <p className="hint">
        {offer.currentTier === 0 ? 'Not installed.' : `Installed: tier ${offer.currentTier}.`}
      </p>
      <ul className="shop" aria-labelledby={id}>
        {offer.tiers.map((t) => {
          const choice = chooseEquipment(tank, economy, offer.device, t.tier);
          const note = `${id}-${t.tier}`;
          return (
            <li key={t.tier}>
              <div>
                <strong>Tier {t.tier}</strong> <Price pearls={t.price} />
                <p className="hint">{t.effect}</p>
                {t.state === 'installed' && <p className="hint">This is what the tank has now.</p>}
                {t.state === 'better-installed' && (
                  <p id={note} className="hint">
                    Not sold: the tank already has a better one, and the shop does not sell
                    downgrades.
                  </p>
                )}
                {t.skipped > 0 && (
                  <p id={note} className="hint">
                    This skips {t.skipped === 1 ? 'a tier' : `${t.skipped} tiers`}; you pay this
                    tier&apos;s own price.
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={busy || !choice.ok}
                aria-label={
                  t.state === 'available'
                    ? `Buy ${offer.label} tier ${t.tier} for ${t.price} Pearls, about ${euroText(t.price, economy)}`
                    : t.state === 'installed'
                      ? `${offer.label} tier ${t.tier} is installed`
                      : `${offer.label} tier ${t.tier} is not sold`
                }
                aria-describedby={t.state === 'available' && t.skipped === 0 ? undefined : note}
                onClick={() => onBuy(t.tier)}
              >
                {t.state === 'installed'
                  ? 'Installed'
                  : t.state === 'available'
                    ? 'Buy'
                    : 'Not sold'}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function EquipmentShop({ session, state, tank, spend }: ShopProps & { spend: Spend }) {
  const id = useId();
  const offers = deviceOffers(tank, economy, BUNDLED_CHEMISTRY);
  const buy = (device: DeviceOffer['device'], tier: number) => {
    const choice = chooseEquipment(tank, economy, device, tier);
    if (!choice.ok) return;
    const offer = offers.find((o) => o.device === device);
    void spend({
      label: `${offer?.label ?? device} tier ${tier}`,
      price: choice.price,
      confirm: true,
      go: () => session.purchase(equipmentRef(device, tier), 'The new equipment is installed.'),
    });
  };
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Equipment</h3>
      {equipmentNote(tank.biome) && <p className="hint">{equipmentNote(tank.biome)}</p>}
      <ul className="equipment">
        {offers.map((o) => (
          <DeviceRow
            key={o.device}
            offer={o}
            tank={tank}
            busy={state.busy}
            onBuy={(tier) => buy(o.device, tier)}
          />
        ))}
      </ul>
    </section>
  );
}

export function LampControl({ session, state, tank }: ShopProps) {
  const id = useId();
  const stored = tank.equipment.light;
  const offset = localOffsetMinutes(new Date());
  const options = hourOptions(offset);
  const [intensity, setIntensity] = useState(stored.intensity);
  const [onHour, setOnHour] = useState(stored.onHour);
  const [offHour, setOffHour] = useState(stored.offHour);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setIntensity(stored.intensity);
    setOnHour(stored.onHour);
    setOffHour(stored.offHour);
    setProblem(null);
  }, [tank.id, stored.intensity, stored.onHour, stored.offHour]);

  if (stored.tier === 0) return null;

  const save = () => {
    const checked = checkLamp({ intensity, onHour, offHour });
    if (!checked.ok) return setProblem(checked.reason);
    setProblem(null);
    void session.setLight(checked.schedule);
  };
  const hourSelect = (suffix: string, label: string, value: number, set: (h: number) => void) => (
    <>
      <label htmlFor={`${id}-${suffix}`}>{label}</label>
      <select id={`${id}-${suffix}`} value={value} onChange={(e) => set(Number(e.target.value))}>
        {!options.some((o) => o.utcHour === value) && (
          <option value={value}>{clockText(value * 60)} UTC</option>
        )}
        {options.map((o) => (
          <option key={o.label} value={o.utcHour}>
            {o.label}
          </option>
        ))}
      </select>
    </>
  );
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Lamp schedule</h3>
      <p className="hint">
        Free to change. Algae grows only while the lamp is on, so a shorter or dimmer day means less
        algae, and a dark tank grows none. Times are shown in your time zone as it is now. The lamp
        keeps to whole hours of UTC, so when the clocks change the lamp comes on an hour earlier or
        later by the clock on your wall.
      </p>
      <div className="inline-form">
        {hourSelect('on', 'Lamp on at', onHour, setOnHour)}
        {hourSelect('off', 'Lamp off at', offHour, setOffHour)}
        <label htmlFor={`${id}-i`}>Strength {Math.round(intensity * 100)}%</label>
        <input
          id={`${id}-i`}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
        />
        <button type="button" disabled={state.busy} onClick={save}>
          Save schedule
        </button>
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <p className="hint">
        {onHour === offHour ? '' : lampSummary({ intensity, onHour, offHour }, offset)}
      </p>
    </section>
  );
}

function SuppliesShop({
  session,
  state,
  spend,
}: {
  session: TankSession;
  state: SessionState;
  spend: Spend;
}) {
  const id = useId();
  const price = economy.items.consumables.bottledBacteria;
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Supplies</h3>
      <ul className="shop">
        <li>
          <div>
            <strong>Bottled bacteria</strong> <Price pearls={price} />
            <p className="hint">
              Seeds the filter with the bacteria that clear ammonia, which speeds recovery after a
              crash. Feeding, water changes, gravel vacuuming and algae scraping are always free.
            </p>
          </div>
          <button
            type="button"
            disabled={state.busy}
            onClick={() =>
              void spend({
                label: 'bottled bacteria',
                price,
                confirm: true,
                go: () => session.careAction({ type: 'bottled_bacteria' }),
              })
            }
          >
            Add to the filter
          </button>
        </li>
      </ul>
    </section>
  );
}

function pieceName(assetId: string): string {
  const spaced = assetId.replaceAll('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function PieceShop({ session, state, tank, spend }: ShopProps & { spend: Spend }) {
  const id = useId();
  const pieces = [...DECOR_ASSET_IDS[tank.biome]].flatMap((assetId) => {
    const plant = Object.hasOwn(economy.items.plant.prices, assetId);
    const price = plant ? economy.items.plant.prices[assetId] : economy.items.decor.prices[assetId];
    return price === undefined
      ? []
      : [{ ref: `${plant ? 'plant' : 'decor'}:${assetId}`, label: pieceName(assetId), price }];
  });
  if (tank.biome === 'reef') {
    pieces.push({
      ref: 'decor:euphyllia',
      label: 'Euphyllia coral',
      price: economy.items.euphyllia,
    });
  }
  const defaultBackground = isPlayableBiome(tank.biome) ? DEFAULT_BACKGROUND_ID[tank.biome] : null;
  const backgrounds = backgroundOptions(tank.biome)
    .filter((b) => b.id !== defaultBackground)
    .map((b) => ({
      ref: `background:${b.id}`,
      label: `Background: ${b.title}`,
      price: economy.items.background.price,
    }));
  const items = [...pieces, ...backgrounds];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-h`} className="block">
      <h3 id={`${id}-h`}>Plants, decor and backgrounds</h3>
      <p className="hint">
        You keep what you buy. Place pieces from the decorate panel. One background per kind of tank
        is free.
      </p>
      <ul className="shop">
        {items.map((item) => (
          <li key={item.ref}>
            <div>
              <strong>{item.label}</strong> <Price pearls={item.price} />
              {state.owned.includes(item.ref) && <p className="hint">You already own this.</p>}
            </div>
            <button
              type="button"
              disabled={state.busy || state.owned.includes(item.ref)}
              aria-label={
                state.owned.includes(item.ref)
                  ? `${item.label}, already owned`
                  : `Buy ${item.label} for ${item.price} Pearls, about ${euroText(item.price, economy)}`
              }
              onClick={() =>
                void spend({
                  label: item.label,
                  price: item.price,
                  confirm: true,
                  go: () => session.purchase(item.ref, `${item.label} is yours.`),
                })
              }
            >
              {state.owned.includes(item.ref) ? 'Owned' : 'Buy'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
