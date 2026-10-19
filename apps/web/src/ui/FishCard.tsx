import type { Fish } from '@aquarium/shared';
import { speciesName, type SpeciesNames } from '../sync/life';
import { personalityOf, traitViews } from '../sync/personality';

export function FishCard({ fish, names }: { fish: Fish; names: SpeciesNames }) {
  const personality = personalityOf(fish);
  const species = speciesName(names, fish.species);
  return (
    <article className="fish-card" aria-label={`${fish.name}, ${species}`}>
      <h4>{fish.name}</h4>
      <p className="hint">{species}</p>
      {personality === null ? (
        <p className="hint">Still getting to know {fish.name}.</p>
      ) : (
        <dl className="traits">
          {traitViews(personality).map((t) => (
            <div key={t.key} className="trait">
              <dt>{t.trait}</dt>
              <dd>
                <strong>{t.word}</strong>
                <meter
                  min={0}
                  max={1}
                  value={t.value}
                  aria-label={`${t.trait} of ${fish.name}`}
                  aria-valuetext={t.word}
                />
                <span className="hint">{t.meaning}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export function FishCards({ fish, names }: { fish: readonly Fish[]; names: SpeciesNames }) {
  const living = fish.filter((f) => f.status === 'alive');
  if (living.length === 0) return null;
  return (
    <section aria-label="Your fish" className="block">
      <h3>Your fish</h3>
      <div className="fish-cards">
        {living.map((f) => (
          <FishCard key={f.id} fish={f} names={names} />
        ))}
      </div>
    </section>
  );
}
