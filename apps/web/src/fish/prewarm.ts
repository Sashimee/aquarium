export interface WarmableLod {
  /** Instances placed this frame. */
  count: number;
  /** False until the LOD has been drawn with its current materials and shadow setting. */
  warmed: boolean;
  readonly matrices: { set(value: ArrayLike<number>, offset?: number): unknown };
  readonly instances: { collapse(index: number): void };
  readonly meshes: readonly { count: number; visible: boolean }[];
}

const COLLAPSED = new Float32Array(16);

/**
 * Sets how many instances each mesh of a LOD draws this frame. three compiles a pipeline the first
 * time a mesh is drawn, and `compileAsync` skips hidden meshes and the shadow pass, so an LOD that no
 * fish uses yet would compile mid-orbit, when the camera first moves a fish across its distance.
 * Until it has drawn, an empty LOD draws one instance collapsed to a point, which rasterises nothing.
 * Its swim data is collapsed too: the shadow pass adds the deformation after the instance matrix, so
 * a departed fish's scale left in slot 0 would draw a speck at the origin.
 */
export function commitLodDraw(lod: WarmableLod): number {
  let drawn = lod.count;
  if (drawn === 0 && !lod.warmed) {
    lod.matrices.set(COLLAPSED, 0);
    lod.instances.collapse(0);
    drawn = 1;
  }
  lod.warmed = true;
  for (const mesh of lod.meshes) {
    mesh.count = drawn;
    mesh.visible = drawn > 0;
  }
  return drawn;
}
