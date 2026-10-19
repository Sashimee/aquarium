export interface FocusCandidate {
  readonly dataset: { readonly opener?: string };
}

/**
 * The element a sheet should hand focus back to. Focus can already sit on another panel's dock
 * button when a sheet mounts (the previous sheet restored it on the way out), and that button is
 * not this sheet's opener.
 */
export function ownOpener<T extends FocusCandidate>(active: T | null, panel: string): T | null {
  if (!active) return null;
  const owner = active.dataset.opener;
  return owner !== undefined && owner !== panel ? null : active;
}
