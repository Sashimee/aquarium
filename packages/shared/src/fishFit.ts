/** The refusal for a species whose adult length the tank's sim cannot hold; `limitM` is that tank's longest fish. */
export function adultLengthRefusalText(
  species: { commonName: string; lifecycle: { maxSizeM: number } },
  limitM: number,
  quarantine: boolean,
): string {
  return `${species.commonName} grows to ${Math.round(species.lifecycle.maxSizeM * 100)} cm, but this tank only holds fish up to ${Math.floor(limitM * 100)} cm. ${quarantine ? 'A quarantine tank is too small for it, so it cannot go there.' : 'Choose a bigger tank.'}`;
}
