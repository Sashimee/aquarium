import { personalitySchema, type Fish, type Personality } from '@aquarium/shared';

export type TraitKey = keyof Personality;

export interface TraitView {
  readonly key: TraitKey;
  readonly trait: string;
  readonly word: string;
  readonly meaning: string;
  readonly value: number;
}

const TRAITS: readonly {
  key: TraitKey;
  trait: string;
  words: readonly [low: string, mid: string, high: string];
  meanings: readonly [low: string, mid: string, high: string];
}[] = [
  {
    key: 'boldness',
    trait: 'Boldness',
    words: ['Shy', 'Steady', 'Bold'],
    meanings: [
      'Startles easily and hides longer.',
      'Neither jumpy nor daring.',
      'Rarely startles and comes out to meet you.',
    ],
  },
  {
    key: 'greed',
    trait: 'Appetite',
    words: ['Picky', 'Hearty', 'Greedy'],
    meanings: [
      'Takes its time and loses out when food is scarce.',
      'An ordinary appetite.',
      'Rushes the food and wins a scarce meal.',
    ],
  },
  {
    key: 'sociability',
    trait: 'Company',
    words: ['Loner', 'Easygoing', 'Social'],
    meanings: [
      'Keeps its distance from the group.',
      'Joins the group when it suits.',
      'Sticks close to the school.',
    ],
  },
];

function band(value: number): 0 | 1 | 2 {
  if (value < 1 / 3) return 0;
  return value < 2 / 3 ? 1 : 2;
}

/** Null for a fish whose record carries no valid personality, e.g. one saved before traits existed. */
export function personalityOf(fish: Pick<Fish, 'personality'>): Personality | null {
  const parsed = personalitySchema.safeParse(fish.personality);
  return parsed.success ? parsed.data : null;
}

export function traitViews(personality: Personality): TraitView[] {
  return TRAITS.map(({ key, trait, words, meanings }) => {
    const value = personality[key];
    const b = band(value);
    return { key, trait, word: words[b], meaning: meanings[b], value };
  });
}
