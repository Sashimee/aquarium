import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chemistryParametersSchema, type ChemistryParameters } from '@aquarium/shared';

const BUNDLED = import.meta.url.endsWith('/src/chemistry.ts')
  ? null
  : fileURLToPath(new URL('./chemistry.json', import.meta.url));
const SOURCE_FILE = fileURLToPath(new URL('../../../content/chemistry.json', import.meta.url));

export function loadChemistryParameters(): ChemistryParameters {
  return chemistryParametersSchema.parse(
    JSON.parse(readFileSync(BUNDLED ?? SOURCE_FILE, 'utf8')) as unknown,
  );
}
