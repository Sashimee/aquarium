import { VACATION_FEEDER_ASSET_ID } from '@aquarium/sim/lifecycle';
import type { CatalogEntry } from '../../scene/assets';
import { heightScale } from '../../scene/coralStyle';
import { HARDSCAPE_KINDS } from '../../scene/hardscape';

export type Vec3Tuple = readonly [number, number, number];

export type DecorKind = 'rock' | 'driftwood' | 'decor' | 'coral' | 'feeder';

export interface DecorSpec {
  readonly assetId: string;
  readonly kind: DecorKind;
  readonly label: string;
  /** Model-space bounds in metres at scale 1, origin on the underside. */
  readonly box: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
}

export { VACATION_FEEDER_ASSET_ID };

export const FEEDER_SPEC: DecorSpec = {
  assetId: VACATION_FEEDER_ASSET_ID,
  kind: 'feeder',
  label: 'Vacation feeder',
  box: { min: [-0.04, 0, -0.03], max: [0.04, 0.045, 0.03] },
};

export function humanize(assetId: string): string {
  const words = assetId.replace(/-\d+$/, '').split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isMovableKind(kind: string): kind is Exclude<DecorKind, 'feeder'> {
  return HARDSCAPE_KINDS.has(kind);
}

function scaleHeight(v: Vec3Tuple, k: number): Vec3Tuple {
  return [v[0], v[1] * k, v[2]];
}

export function specsFromCatalog(entries: Iterable<CatalogEntry>): Map<string, DecorSpec> {
  const specs = new Map<string, DecorSpec>([[FEEDER_SPEC.assetId, FEEDER_SPEC]]);
  for (const entry of entries) {
    if (!isMovableKind(entry.kind) || !entry.bounds) continue;
    specs.set(entry.id, {
      assetId: entry.id,
      kind: entry.kind,
      label: humanize(entry.id),
      box: {
        min: scaleHeight(entry.bounds.min, heightScale(entry.id)),
        max: scaleHeight(entry.bounds.max, heightScale(entry.id)),
      },
    });
  }
  return specs;
}
