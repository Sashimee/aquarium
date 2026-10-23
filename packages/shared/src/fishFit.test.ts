import { describe, expect, it } from 'vitest';
import { adultLengthRefusalText } from './fishFit.js';

const tang = { commonName: 'Blue tang', lifecycle: { maxSizeM: 0.267 } };

describe('adultLengthRefusalText', () => {
  it('points a display tank at a bigger one', () => {
    expect(adultLengthRefusalText(tang, 0.2168, false)).toBe(
      'Blue tang grows to 27 cm, but this tank only holds fish up to 21 cm. Choose a bigger tank.',
    );
  });

  it('says a quarantine tank is too small', () => {
    expect(adultLengthRefusalText(tang, 0.2168, true)).toBe(
      'Blue tang grows to 27 cm, but this tank only holds fish up to 21 cm. A quarantine tank is too small for it, so it cannot go there.',
    );
  });
});
