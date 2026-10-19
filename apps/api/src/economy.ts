import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { economySchema, type Economy } from '@aquarium/shared';

const BUNDLED = import.meta.url.endsWith('/src/economy.ts')
  ? null
  : fileURLToPath(new URL('./economy.json', import.meta.url));
const SOURCE_FILE = fileURLToPath(new URL('../../../content/economy.json', import.meta.url));

export function loadEconomy(): Economy {
  return economySchema.parse(JSON.parse(readFileSync(BUNDLED ?? SOURCE_FILE, 'utf8')) as unknown);
}
