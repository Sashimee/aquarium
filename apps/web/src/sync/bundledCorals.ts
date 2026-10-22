import { coralContentSchema, type CoralContent } from '@aquarium/shared';

const coralFiles = import.meta.glob<unknown>('../../../../content/corals.json', {
  eager: true,
  import: 'default',
});

/** Thresholds shown to the player; the server judges every cut and bleaching from its own copy. */
export const BUNDLED_CORALS: CoralContent = coralContentSchema.parse(
  (() => {
    const [raw] = Object.values(coralFiles);
    if (raw === undefined) throw new Error('content/corals.json is missing from this build');
    return raw;
  })(),
);
