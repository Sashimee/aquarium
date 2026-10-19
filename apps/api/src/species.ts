import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadChemistryParameters } from './chemistry.ts';
import { isWarmWater, speciesContentSummarySchema, type SpeciesSummary } from '@aquarium/shared';

export type SpeciesCatalog = ReadonlyMap<string, SpeciesSummary>;

const BUNDLED = import.meta.url.endsWith('/src/species.ts')
  ? null
  : fileURLToPath(new URL('./species.json', import.meta.url));
const SOURCE_DIR = fileURLToPath(new URL('../../../content/species', import.meta.url));

// Behaviour, locomotion and render blocks belong to the client; the server only needs these.
const entrySchema = speciesContentSummarySchema.loose();

export function parseCatalog(entries: readonly unknown[], roomC: number): SpeciesCatalog {
  const catalog = new Map<string, SpeciesSummary>();
  for (const entry of entries) {
    const parsed = entrySchema.parse(entry);
    const { id, commonName, scientificName, biome, lifecycle, chemistry, breeding } = parsed;
    if (catalog.has(id)) throw new Error(`Duplicate species id "${id}" in content/species.`);
    const warmWater = isWarmWater(chemistry, roomC);
    catalog.set(id, {
      id,
      commonName,
      scientificName,
      biome,
      lifecycle,
      chemistry,
      breeding,
      warmWater,
    });
  }
  if (catalog.size === 0) throw new Error('No species found: content/species is empty.');
  return catalog;
}

export function loadCatalog(roomC = loadChemistryParameters().temperature.roomC): SpeciesCatalog {
  if (BUNDLED) return parseCatalog(JSON.parse(readFileSync(BUNDLED, 'utf8')) as unknown[], roomC);
  return parseCatalog(
    readdirSync(SOURCE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(`${SOURCE_DIR}/${name}`, 'utf8')) as unknown),
    roomC,
  );
}
