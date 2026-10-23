import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The e2e tsconfig cannot resolve @aquarium/shared, so the constants are read from its source.
const source = readFileSync(resolve(process.cwd(), 'packages/shared/src/community.ts'), 'utf8');

function portions(name: string): { portions: number; windowMs: number } {
  const match = new RegExp(
    `${name} = \\{ portions: ([0-9.]+), windowMs: ([0-9]+) \\* HOUR_MS`,
  ).exec(source);
  if (!match?.[1] || !match[2])
    throw new Error(`${name} not found in packages/shared community.ts`);
  return { portions: Number(match[1]), windowMs: Number(match[2]) * 3_600_000 };
}

export const COMMUNITY_TANK_FEED_CAP = portions('COMMUNITY_TANK_FEED_CAP');
export const COMMUNITY_USER_FEED_QUOTA = portions('COMMUNITY_USER_FEED_QUOTA');
