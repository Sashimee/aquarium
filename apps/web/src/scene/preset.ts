import { presetLayoutSchema, type Biome, type PresetLayout } from '@aquarium/shared';
import freshwater from '../../../../content/presets/freshwater.json';
import reef from '../../../../content/presets/reef.json';
import cichlid from '../../../../content/presets/cichlid.json';

const SOURCES: Readonly<Partial<Record<Biome, unknown>>> = { freshwater, reef, cichlid };

export function parsePreset(source: unknown, label: string): PresetLayout {
  const result = presetLayoutSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Preset ${label} is invalid: ${issues}`);
  }
  return result.data;
}

export function loadPreset(biome: Biome): PresetLayout {
  const source = SOURCES[biome];
  if (source === undefined) {
    throw new Error(`No preset for biome "${biome}" yet; add content/presets/${biome}.json`);
  }
  return parsePreset(source, `${biome}.json`);
}
