import type { Fish } from '@aquarium/shared';
import { useId, useState } from 'react';
import { speciesName, type SpeciesNames } from '../sync/life';
import { DISEASE_LABEL, severityWord, sickSummary, SYMPTOMS } from '../sync/treatment';
import { personalityOf, traitViews } from '../sync/personality';

export function FishCard({ fish, names }: { fish: Fish; names: SpeciesNames }) {
  const personality = personalityOf(fish);
  const species = speciesName(names, fish.species);
  const id = useId();
  return (
    <article className="fish-card" aria-labelledby={`${id}-name ${id}-species`}>
      <h4 id={`${id}-name`}>{fish.name}</h4>
      <p className="hint" id={`${id}-species`}>
        {species}
      </p>
      {fish.disease && (
        <p className="symptom">
          <strong>{DISEASE_LABEL[fish.disease.kind]}</strong>, {severityWord(fish.disease.severity)}
          : {SYMPTOMS[fish.disease.kind]}.
          {fish.disease.treatedUntil !== null &&
            Date.parse(fish.disease.treatedUntil) > Date.now() &&
            ' Medicine is working on it.'}
        </p>
      )}
      {personality === null ? (
        <p className="hint">Still getting to know {fish.name}.</p>
      ) : (
        <dl className="traits">
          {traitViews(personality).map((t) => (
            <div key={t.key} className="trait">
              <dt>{t.trait}</dt>
              <dd>
                <strong aria-hidden="true">{t.word}</strong>
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

export const FISH_CARDS_COLLAPSED = 8;

export function FishCards({ fish, names }: { fish: readonly Fish[]; names: SpeciesNames }) {
  const [expanded, setExpanded] = useState(false);
  const living = fish.filter((f) => f.status === 'alive');
  if (living.length === 0) return null;
  const hidden = expanded ? 0 : Math.max(0, living.length - FISH_CARDS_COLLAPSED);
  const shown = hidden > 0 ? living.slice(0, FISH_CARDS_COLLAPSED) : living;
  return (
    <section aria-label="Your fish" className="block">
      <h3>Your fish</h3>
      <p role="status" className="sr-only">
        {sickSummary(living)}
      </p>
      <div className="fish-cards">
        {shown.map((f) => (
          <FishCard key={f.id} fish={f} names={names} />
        ))}
      </div>
      {living.length > FISH_CARDS_COLLAPSED && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer fish' : `Show all ${living.length} fish`}
        </button>
      )}
    </section>
  );
}
