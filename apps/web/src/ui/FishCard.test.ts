import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Fish } from '@aquarium/shared';
import { FISH_1, FISH_2, fishFixture, speciesFixture } from '../sync/fixtures';
import { speciesNameMap } from '../sync/life';
import { personalityOf, traitViews } from '../sync/personality';
import { FishCard, FishCards } from './FishCard';

const names = speciesNameMap([speciesFixture()]);

function card(fish: Fish): string {
  return renderToStaticMarkup(createElement(FishCard, { fish, names }));
}

function legacy(name: string): Fish {
  return { ...fishFixture(FISH_1, { name }), personality: undefined } as unknown as Fish;
}

describe('traitViews', () => {
  it.each([
    [0, ['Shy', 'Picky', 'Loner']],
    [0.5, ['Steady', 'Hearty', 'Easygoing']],
    [1, ['Bold', 'Greedy', 'Social']],
  ])('puts every trait at %s into its plain word', (value, words) => {
    const views = traitViews({ boldness: value, greed: value, sociability: value });
    expect(views.map((v) => v.word)).toEqual(words);
    expect(views.every((v) => v.meaning.length > 0)).toBe(true);
  });

  it('switches words at the third boundaries', () => {
    const word = (boldness: number) =>
      traitViews({ boldness, greed: 0.5, sociability: 0.5 })[0]?.word;
    expect(word(0.333)).toBe('Shy');
    expect(word(0.334)).toBe('Steady');
    expect(word(0.666)).toBe('Steady');
    expect(word(0.667)).toBe('Bold');
  });
});

describe('personalityOf', () => {
  it('reads a stored personality', () => {
    const p = { boldness: 0.1, greed: 0.2, sociability: 0.3 };
    expect(personalityOf(fishFixture(FISH_1, { personality: p }))).toEqual(p);
  });

  it.each([undefined, null, {}, { boldness: 2, greed: 0, sociability: 0 }])(
    'is null for a missing or malformed personality (%j)',
    (bad) => {
      const fish = { ...fishFixture(FISH_1), personality: bad } as unknown as Fish;
      expect(personalityOf(fish)).toBeNull();
    },
  );
});

describe('FishCard', () => {
  it('lists the three traits with a word, a labelled meter and a meaning', () => {
    const html = card(
      fishFixture(FISH_1, {
        name: 'Pearl',
        personality: { boldness: 0.9, greed: 0.1, sociability: 0.5 },
      }),
    );
    expect(html).toContain('<dl');
    for (const trait of ['Boldness', 'Appetite', 'Company']) expect(html).toContain(trait);
    for (const word of ['Bold', 'Picky', 'Easygoing']) expect(html).toContain(word);
    expect(html).toContain('aria-label="Boldness of Pearl"');
    expect(html).toContain('aria-valuetext="Bold"');
    expect(html.match(/<meter/g)).toHaveLength(3);
  });

  it('says it is still getting to know a fish with no personality data', () => {
    const html = card(legacy('Pearl'));
    expect(html).toContain('Still getting to know Pearl.');
    expect(html).not.toContain('<meter');
    expect(html).not.toContain('<dl');
  });
});

describe('FishCards', () => {
  it('shows living fish only and nothing for an empty tank', () => {
    const fish = [
      fishFixture(FISH_1, { name: 'Pearl' }),
      fishFixture(FISH_2, { name: 'Ghost', status: 'dead' }),
    ];
    const html = renderToStaticMarkup(createElement(FishCards, { fish, names }));
    expect(html).toContain('Pearl');
    expect(html).not.toContain('Ghost');
    expect(renderToStaticMarkup(createElement(FishCards, { fish: [], names }))).toBe('');
  });

  it('does not break on a tank mixing legacy and current fish', () => {
    const fish = [legacy('Old'), fishFixture(FISH_2, { name: 'New' })];
    const html = renderToStaticMarkup(createElement(FishCards, { fish, names }));
    expect(html).toContain('Still getting to know Old.');
    expect(html).toContain('Boldness of New');
  });
});
