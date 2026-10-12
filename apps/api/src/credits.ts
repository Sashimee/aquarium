import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  creditsSchema,
  httpUrlSchema,
  slugSchema,
  type Credits,
  type CreditEntry,
} from '@aquarium/shared';
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
  author_url: httpUrlSchema,
  source_url: httpUrlSchema,
  licence: z.string().min(1),
  licence_url: httpUrlSchema,
  species: slugSchema.optional(),
  modifications: z.array(z.string()),
  status: z.string(),
});

const manifestSchema = z.looseObject({ assets: z.array(manifestAssetSchema).min(1) });

export const UNRECORDED_MODIFICATION = 'modified (processed for web)';

const FREE_LICENCES = new Set(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0']);

const APPROVED_SHARE_ALIKE_AUTHORS = new Map([
  ['bronze-corydoras', 'Gabriel Resende Veiga (GABS)'],
  ['royal-gramma', 'H. Zell (Llez)'],
  ['banggai-cardinalfish', 'David J. Stang'],
]);

export const SHARE_ALIKE_NOTICE =
  'Reference photographs marked ShareAlike are licensed under Creative Commons BY-SA. ' +
  'Textures derived from them are released under the same licence, with the attribution shown here.';

const licenceRank = (licence: string): number =>
  licence.startsWith('CC-BY-SA') ? 0 : licence.startsWith('CC-BY') ? 1 : 2;

type ManifestAsset = z.infer<typeof manifestAssetSchema>;

function assertLicenceAllowed(a: ManifestAsset): void {
  if (FREE_LICENCES.has(a.licence)) return;
  const approvedAuthor = a.species ? APPROVED_SHARE_ALIKE_AUTHORS.get(a.species) : undefined;
  const shareAlikeOk =
    (a.licence === 'CC-BY-SA-3.0' || a.licence === 'CC-BY-SA-4.0') &&
    a.kind === 'reference-photo' &&
    approvedAuthor !== undefined &&
    a.author === approvedAuthor;
  if (!shareAlikeOk) {
    throw new Error(
      `Asset "${a.id}" has licence ${a.licence} (author ${a.author}), which is not allowed: ` +
        'only CC0, CC-BY 3.0/4.0 and the approved CC-BY-SA reference photos may ship (docs/PLAN.md, issue #29). ' +
        'Fix assets/manifest.json.',
    );
  }
}

export function buildCredits(manifest: unknown): Credits {
  const { assets } = manifestSchema.parse(manifest);
  assets.forEach(assertLicenceAllowed);
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
      referenceOnly: a.kind === 'reference-photo',
      modifications:
        a.kind === 'reference-photo' || a.licence === 'CC0-1.0'
          ? a.modifications
          : a.modifications.length > 0
            ? a.modifications
            : [UNRECORDED_MODIFICATION],
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
