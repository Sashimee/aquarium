import { biomeSchema } from '@aquarium/shared';

export class PresetNameError extends Error {}

function presetNameProblems(fileNames: readonly string[], biomes: readonly string[]): string[] {
  const present = new Set(fileNames.map((name) => name.slice(0, -'.json'.length)));
  const problems: string[] = [];
  for (const name of [...present].sort()) {
    if (!biomes.includes(name)) {
      problems.push(
        `content/presets/${name}.json is not a known biome (${biomes.join(', ')}). Rename or delete it, or add the biome to biomeSchema in packages/shared/src/common.ts.`,
      );
    }
  }
  for (const biome of biomes) {
    if (!present.has(biome)) {
      problems.push(
        `Biome "${biome}" has no preset. Add content/presets/${biome}.json, or remove the biome from biomeSchema in packages/shared/src/common.ts.`,
      );
    }
  }
  return problems;
}

export function assertPresetNames(
  fileNames: readonly string[],
  biomes: readonly string[] = biomeSchema.options,
): void {
  const problems = presetNameProblems(fileNames, biomes);
  if (problems.length > 0) {
    throw new PresetNameError(`Preset validation failed:\n- ${problems.join('\n- ')}`);
  }
}
