import type { Personality } from '@aquarium/shared';
import { createHash } from 'node:crypto';

// Must stay identical to the SQL in drizzle/0014_personality_visits.sql: that migration backfills
// with the same md5 construction, so a backfilled fish and a newly derived one agree.
const trait = (fishId: string, name: string): number => {
  const head = createHash('md5').update(`${fishId}${name}`).digest('hex').slice(0, 8);
  return Math.round((parseInt(head, 16) / 0xffffffff) * 1000) / 1000;
};

export const personalityFromFishId = (fishId: string): Personality => ({
  boldness: trait(fishId, 'boldness'),
  greed: trait(fishId, 'greed'),
  sociability: trait(fishId, 'sociability'),
});
