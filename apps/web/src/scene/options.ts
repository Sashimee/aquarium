export interface SceneOptions {
  /** `?colliders=1` shows the collider wireframes. */
  colliders: boolean;
}

export function parseSceneOptions(search: string): SceneOptions {
  const params = new URLSearchParams(search);
  const colliders = params.get('colliders');
  if (colliders !== null && colliders !== '0' && colliders !== '1') {
    throw new Error(`Unknown ?colliders=${colliders}; use 0 or 1`);
  }
  return { colliders: colliders === '1' };
}
