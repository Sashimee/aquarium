import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { creditsSchema, slugSchema, type Credits, type CreditEntry } from '@aquarium/shared';
import { z } from 'zod';

const BUNDLED = import.meta.url.endsWith('/src/credits.ts')
  ? null
  : fileURLToPath(new URL('./manifest.json', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../assets/manifest.json', import.meta.url));

const manifestAssetSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  author_url: z.url(),
  source_url: z.url(),
  licence: z.string().min(1),
  licence_url: z.url(),
  species: slugSchema.optional(),
  modifications: z.array(z.string()),
  status: z.string(),
});

const manifestSchema = z.looseObject({ assets: z.array(manifestAssetSchema).min(1) });

export const UNRECORDED_MODIFICATION = 'modified (processed for web)';

export const SHARE_ALIKE_NOTICE =
  'Reference photographs marked ShareAlike are licensed under Creative Commons BY-SA. ' +
  'Textures derived from them are released under the same licence, with the attribution shown here.';

const licenceRank = (licence: string): number =>
  licence.startsWith('CC-BY-SA') ? 0 : licence.startsWith('CC-BY') ? 1 : 2;

export function buildCredits(manifest: unknown): Credits {
  const { assets } = manifestSchema.parse(manifest);
  const entries: CreditEntry[] = assets
    .filter((a) => a.status === 'downloaded')
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      author: a.author,
      authorUrl: a.author_url,
      sourceUrl: a.source_url,
      licence: a.licence,
      licenceUrl: a.licence_url,
      attribution: `"${a.title}" by ${a.author}, licensed under ${a.licence}.`,
      shareAlike: a.licence.startsWith('CC-BY-SA'),
      species: a.species ?? null,
      modifications: a.modifications.length > 0 ? a.modifications : [UNRECORDED_MODIFICATION],
    }))
    .sort(
      (a, b) =>
        licenceRank(a.licence) - licenceRank(b.licence) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
  return creditsSchema.parse({
    generatedFrom: 'assets/manifest.json',
    shareAlikeNotice: SHARE_ALIKE_NOTICE,
    entries,
  });
}

export function loadCredits(): Credits {
  return buildCredits(JSON.parse(readFileSync(BUNDLED ?? SOURCE, 'utf8')));
}
