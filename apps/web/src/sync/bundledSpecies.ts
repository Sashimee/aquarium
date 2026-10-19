import { speciesSchema } from '@aquarium/shared';

const contentSchema = speciesSchema.partial({ render: true });

const files = import.meta.glob<unknown>('../../../../content/species/*.json', {
  eager: true,
  import: 'default',
});

const NAMES = new Map<string, string>();
for (const raw of Object.values(files)) {
  const { id, commonName } = contentSchema.parse(raw);
  NAMES.set(id, commonName);
}

/** The bundled common name, or the slug spelled out when this build has no content for the species. */
export function bundledCommonName(id: string): string {
  return NAMES.get(id) ?? id.replaceAll('-', ' ');
}
