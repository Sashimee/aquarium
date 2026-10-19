import type { Achievement, Collection } from '@aquarium/shared';
import { ApiRequestError } from './api';

type SpeciesRow = Collection['species'][number];

export type SpeciesCard =
  | {
      kind: 'found';
      species: string;
      name: string;
      biome: string;
      keptOn: string;
      milestones: string[];
    }
  | { kind: 'locked'; species: string; biome: string };

export type AchievementRow = {
  id: string;
  title: string;
  description: string;
  earned: boolean;
  earnedOn: string | null;
  progress: number;
  target: number;
  progressText: string;
};

export function formatDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

export function speciesCard(row: SpeciesRow): SpeciesCard {
  const { entry } = row;
  if (!entry) return { kind: 'locked', species: row.species, biome: row.biome };
  const milestones: string[] = [];
  if (entry.bredAt) milestones.push(`Bred ${formatDay(entry.bredAt)}`);
  if (entry.raisedAt) milestones.push(`Raised to adult ${formatDay(entry.raisedAt)}`);
  return {
    kind: 'found',
    species: row.species,
    name: row.commonName,
    biome: row.biome,
    keptOn: formatDay(entry.keptAt),
    milestones,
  };
}

export function achievementRow(a: Achievement): AchievementRow {
  const earned = a.earnedAt !== null;
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    earned,
    earnedOn: a.earnedAt ? formatDay(a.earnedAt) : null,
    progress: a.progress,
    target: a.target,
    progressText: earned ? 'Done' : `${a.progress} of ${a.target}`,
  };
}

export function collectionSummary(c: Pick<Collection, 'kept' | 'bred' | 'raised' | 'total'>) {
  return `${c.kept} of ${c.total} species kept, ${c.bred} bred, ${c.raised} raised to adult.`;
}

export function collectionErrorMessage(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.code === 'unauthenticated') {
      return 'Sign in with a verified account to keep a collection book.';
    }
    if (cause.code === 'email_not_verified') {
      return 'Verify your email address to keep a collection book. Check your inbox for the link.';
    }
    if (cause.code === 'rate_limited') {
      const wait = cause.retryAfterSeconds;
      return wait
        ? `Too many requests. Try again in ${Math.ceil(wait)} s.`
        : 'Too many requests. Try again in a moment.';
    }
    return cause.message;
  }
  return 'The collection could not be loaded. Check your connection and try again.';
}
