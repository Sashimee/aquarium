import { Box3, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import catalogJson from '../../../public/assets/index.json';
import type { CatalogEntry } from '../../scene/assets';
import { decorMatrix } from '../../scene/hardscape';
import { footprintOf } from './footprint';
import { specsFromCatalog } from './spec';

const entries = catalogJson.assets as unknown as CatalogEntry[];
const specs = specsFromCatalog(entries);

describe('specsFromCatalog', () => {
  it.each(['brain-coral', 'boulder-01'])('box of %s matches the rendered mesh height', (id) => {
    const entry = entries.find((e) => e.id === id);
    const spec = specs.get(id);
    if (!entry?.bounds || !spec) throw new Error(`${id} missing from the catalog`);
    const item = { assetId: id, position: [0.1, 0.05, -0.1] as const, rotationY: 1.2, scale: 0.7 };
    const mesh = new Box3(
      new Vector3(...entry.bounds.min),
      new Vector3(...entry.bounds.max),
    ).applyMatrix4(decorMatrix(item));
    const footprint = footprintOf(spec, item);
    expect(footprint.yMax).toBeCloseTo(mesh.max.y, 6);
    expect(footprint.yMin).toBeCloseTo(mesh.min.y, 6);
  });
});
