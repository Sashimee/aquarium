import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { biomeSchema, presetLayoutSchema, type Biome, type PresetLayout } from '@aquarium/shared';

export type Presets = Partial<Record<Biome, PresetLayout>>;

const BUNDLED = import.meta.url.endsWith('/src/presets.ts')
  ? null
  : fileURLToPath(new URL('./presets.json', import.meta.url));
const SOURCE_DIR = fileURLToPath(new URL('../../../content/presets', import.meta.url));

export function loadPresets(): Presets {
  const bundled = BUNDLED
    ? (JSON.parse(readFileSync(BUNDLED, 'utf8')) as Record<string, unknown>)
    : null;
  const out: Presets = {};
  for (const biome of biomeSchema.options) {
    const source =
      bundled?.[biome] ??
      (JSON.parse(readFileSync(`${SOURCE_DIR}/${biome}.json`, 'utf8')) as unknown);
    out[biome] = presetLayoutSchema.parse(source);
  }
  return out;
}
