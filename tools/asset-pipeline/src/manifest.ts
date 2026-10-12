import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ALLOWED_LICENCES = ['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0'] as const;
export const SHARE_ALIKE_LICENCES = ['CC-BY-SA-3.0', 'CC-BY-SA-4.0'] as const;
export const SHARE_ALIKE_KIND = 'reference-photo';
/** CC-BY-SA is approved for exactly these reference photos (Corydoras aeneus, Gramma loreto, Pterapogon kauderni) and nothing else. */
export const SHARE_ALIKE_ALLOWLIST: readonly { id: string; species: string; author: string }[] = [
  {
    id: 'wm-cory-aeneus-gabs-01',
    species: 'bronze-corydoras',
    author: 'Gabriel Resende Veiga (GABS)',
  },
  {
    id: 'wm-cory-aeneus-gabs-03',
    species: 'bronze-corydoras',
    author: 'Gabriel Resende Veiga (GABS)',
  },
  { id: 'wm-gramma-loreto-llez', species: 'royal-gramma', author: 'H. Zell (Llez)' },
  { id: 'wm-banggai-stang-8zz', species: 'banggai-cardinalfish', author: 'David J. Stang' },
  { id: 'wm-banggai-stang-10zz', species: 'banggai-cardinalfish', author: 'David J. Stang' },
];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');

export const manifestFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.int().nonnegative(),
});

export const manifestAssetSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  species: z.string().min(1).optional(),
  title: z.string(),
  author: z.string(),
  author_url: z.string(),
  source_url: z.string(),
  licence: z.string().min(1),
  licence_url: z.string(),
  sha256: sha256Schema.nullable(),
  modifications: z.array(z.string()),
  status: z.string().min(1),
  files: z.array(manifestFileSchema).optional(),
});
export type ManifestAsset = z.infer<typeof manifestAssetSchema>;

export const manifestSchema = z.looseObject({
  version: z.int(),
  status_values: z.array(z.string().min(1)).min(1),
  rules: z.array(z.string()),
  assets: z.array(manifestAssetSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const PENDING_STATUS = 'selected-pending-download';

export function aggregateSha256(files: readonly { path: string; sha256: string }[]): string {
  const lines = files
    .map((f) => ({ path: f.path, line: `${f.sha256}  ${f.path}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => f.line);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function isShareAlike(licence: string): boolean {
  return (SHARE_ALIKE_LICENCES as readonly string[]).includes(licence);
}

export function isAllowedShareAlike(asset: ManifestAsset): boolean {
  return (
    isShareAlike(asset.licence) &&
    asset.kind === SHARE_ALIKE_KIND &&
    SHARE_ALIKE_ALLOWLIST.some(
      (entry) =>
        entry.id === asset.id && entry.species === asset.species && entry.author === asset.author,
    )
  );
}

const LICENCE_RANK: Record<string, number> = {
  'CC0-1.0': 0,
  'CC-BY-3.0': 1,
  'CC-BY-4.0': 1,
  'CC-BY-SA-3.0': 2,
  'CC-BY-SA-4.0': 2,
};

export function licenceRank(licence: string): number | undefined {
  return LICENCE_RANK[licence];
}

/** The most restrictive of the source licences; CC0 when there are none. Throws on a licence the project does not know. */
export function strictestLicence(licences: readonly string[]): string {
  let best = 'CC0-1.0';
  for (const licence of licences) {
    const rank = licenceRank(licence);
    if (rank === undefined)
      throw new Error(`unknown licence "${licence}"; only CC0 and CC-BY(-SA) are allowed`);
    if (rank > (licenceRank(best) ?? 0)) best = licence;
  }
  return best;
}

export function requiresCredit(licence: string): boolean {
  return licence !== 'CC0-1.0';
}

export function validateManifest(manifest: Manifest, credits: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const asset of manifest.assets) {
    const at = `manifest asset ${asset.id}`;
    if (seen.has(asset.id)) problems.push(`${at}: duplicate id`);
    seen.add(asset.id);

    if (!manifest.status_values.includes(asset.status)) {
      problems.push(
        `${at}: status "${asset.status}" is not one of ${manifest.status_values.join(', ')}`,
      );
    }
    const pending = asset.status === PENDING_STATUS;
    if (pending && asset.sha256 !== null)
      problems.push(`${at}: pending asset must have sha256 null`);
    if (!pending && asset.sha256 === null) {
      problems.push(`${at}: sha256 is null but status is "${asset.status}"`);
    }
    if (asset.files && asset.sha256 !== null) {
      const expected = aggregateSha256(asset.files);
      if (expected !== asset.sha256) {
        problems.push(
          `${at}: sha256 ${asset.sha256} is not the aggregate over files[] (expected ${expected})`,
        );
      }
    }

    const licenceOk =
      (ALLOWED_LICENCES as readonly string[]).includes(asset.licence) || isAllowedShareAlike(asset);
    if (!licenceOk) {
      problems.push(
        isShareAlike(asset.licence)
          ? `${at}: ${asset.licence} is only allowed for the approved ${SHARE_ALIKE_KIND} ids (${SHARE_ALIKE_ALLOWLIST.map((e) => e.id).join(', ')}); got "${asset.id}" (kind "${asset.kind}", author "${asset.author}")`
          : `${at}: licence "${asset.licence}" is not CC0-1.0, CC-BY-3.0 or CC-BY-4.0`,
      );
    }

    if (requiresCredit(asset.licence)) {
      for (const field of ['author', 'author_url', 'source_url', 'licence_url'] as const) {
        if (asset[field].trim() === '')
          problems.push(`${at}: ${asset.licence} asset has empty ${field}`);
      }
      if (!credits.includes(`\`${asset.id}\``)) {
        problems.push(`${at}: ${asset.licence} asset is not credited in CREDITS.md`);
      } else if (asset.author.trim() !== '' && !credits.includes(asset.author)) {
        problems.push(`${at}: CREDITS.md does not name author "${asset.author}"`);
      }
    }
  }
  return problems;
}
