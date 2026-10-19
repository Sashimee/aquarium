import type { DiseaseKind, DiseaseState } from '@aquarium/shared';
import type { InstanceValues } from './instances';

type DiseaseSigns = Pick<InstanceValues, 'ich' | 'finRot' | 'velvet'>;

const SIGN: Record<DiseaseKind, keyof DiseaseSigns> = {
  ich: 'ich',
  'fin-rot': 'finRot',
  velvet: 'velvet',
};

/**
 * Sets the severity of the fish's one disease and clears the others. Walkers carry none of these
 * diseases, so they always draw healthy.
 */
export function writeDiseaseSigns(
  disease: DiseaseState | null,
  walker: boolean,
  out: DiseaseSigns,
): void {
  out.ich = 0;
  out.finRot = 0;
  out.velvet = 0;
  if (disease === null || walker) return;
  const { severity } = disease;
  if (!(severity >= 0 && severity <= 1)) {
    throw new RangeError(`fish disease: severity must be within 0..1, got ${severity}`);
  }
  out[SIGN[disease.kind]] = severity;
}
