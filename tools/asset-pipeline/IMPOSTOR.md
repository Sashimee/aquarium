# Fish impostor atlas (contract for the TSL impostor, #608)

Every fish in `index.json` carries an `impostor` block and two KTX2 files next to its LODs:

```
fish/<id>/impostor_albedo.ktx2   ETC1S, sRGB
fish/<id>/impostor_normal.ktx2   UASTC, linear
```

The atlas is baked from `lod1` (`sourceLod`), at the rest pose, in **fish space** (+Z forward, +Y up,
origin at the centre of mass, metres). It is a bake of the static mesh: the swim wave and fin motion
are not in it, so the shader has to bend the quad itself and may use the fin mask to damp the bend on
the fins.

## `index.json` entry

```jsonc
"impostor": {
  "sourceLod": 1,
  "layout": "octahedral",
  "pose": "rest",
  "grid": 8,            // frames per side; frames = grid * grid
  "frameSize": 128,     // pixels per frame side
  "atlasSize": 1024,    // grid * frameSize, both axes
  "pivot": [x, y, z],   // fish-space point every frame is centred on (bounding-box centre), metres
  "radius": 0.0436,     // half-extent of every frame in metres, a sphere around pivot
  "albedo":      { "file": "...", "bytes": 0, "sha256": "...", "codec": "etc1s" },
  "normalDepth": { "file": "...", "bytes": 0, "sha256": "...", "codec": "uastc" }
}
```

A quad that shows one frame is `2 * radius` metres on a side, centred on `pivot` (rotated into world
space with the fish). That size is the same for every view, so the pivot and silhouette do not jump
between frames.

## Why a full octahedron

Fish are seen from below as often as from above: a camera at mid-tank looks up at everything in the
top half, and fish pitch while climbing and diving. A hemi-octahedron would need a second lookup for
those views. Cost of the full sphere: half the frames show the underside, which is cheap because the
atlas is small (8 x 8 at 128 px is about 0.5 MB per species).

## View direction to frame

`d` is the unit vector **from the fish towards the camera, in fish space**. (`tools/asset-pipeline/src/octahedral.ts`
is the reference implementation, with tests; port it to TSL unchanged.)

```
uv  = octahedral(d)       // +Y at (0.5, 0.5), -Y at the four corners, +X (1, .5), -X (0, .5), +Z (.5, 1), -Z (.5, 0)
g   = uv * (grid - 1)     // frames sit on grid POINTS, not cell centres
i,j = floor(g), fract(g)  // blend the 4 surrounding frames bilinearly
```

Frame `(i, j)` was rendered along `cellDirection(i, j, grid) = decode(i / (grid-1), j / (grid-1))`.
`i` is the column, `j` the row **counted from the top of the stored image** (KTX2Loader textures are
not flipped, so atlas `v = (j * frameSize + y) / atlasSize` with `v = 0` at the first row). Frames on
the border are duplicates of the opposite border where the fold meets, and all four corners are the
same -Y view; that keeps the bilinear blend exact everywhere with no wrap logic.

Pixel `(x, y)` of a frame, `y` from the top:

```
p = pivot + radius * ( (2 * (x + .5) / frameSize - 1) * right
                     + (1 - 2 * (y + .5) / frameSize) * up
                     + depthOffset * toward )
```

with `viewBasis(d)`: `right = normalize(cross(reference, d))`, `up = cross(d, right)`, `toward = d`;
`reference = +Y`, or `+Z` when `|d.y| > 1 - 1e-6` (the poles). A fish seen from its +Z side has `+X`
to the right and `+Y` up.

## Channels

| file              | R                    | G                    | B             | A                                 |
| ----------------- | -------------------- | -------------------- | ------------- | --------------------------------- |
| `impostor_albedo` | base colour R (sRGB) | G                    | B             | coverage 0..1 (anti-aliased edge) |
| `impostor_normal` | normal, octahedral u | normal, octahedral v | fin mask 0..1 | depth                             |

- Albedo is unlit base colour (texture times material factor), so the shader relights it. Colour is
  bled up to 4 px past the silhouette and filled with the frame's mean colour beyond that, so
  filtering and mips never pull black into the edge; use alpha, not colour, to find the silhouette.
- Normal is the interpolated **vertex** normal in **fish space** (rotate it by the fish's world
  rotation before lighting), flipped to face the camera on thin double-sided fins. It is encoded with
  the same octahedral map as directions: `n = uvToDirection(R, G)`. The tangent-space normal map is
  not baked.
- Fin mask is `_FIN_MASK` on fin vertices (`_FIN_ID > 0`) and 0 on the rigid body.
- Depth is `0.5 + 0.5 * dot(p - pivot, d) / radius`: 0.5 on the plane through the pivot, larger
  towards the camera. Use `(depth - 0.5) * 2 * radius` metres to push the fragment depth out of the
  quad for sorting against decor.
- Outside the silhouette (`alpha = 0`) normal, mask and depth are bled 4 px like colour, then become
  neutral: the frame's own view direction, mask 0, depth 0.5.

## Sampling notes

- Mips are generated across the whole atlas. Cap the sampled level at `log2(frameSize) - 4` (level 3
  for 128 px frames) so a frame is never mixed with its neighbour. The silhouette rim is empty by
  construction (`radius` has 2 percent margin), which hides the mixing below that level.
- Use `LinearFilter`. The 4-frame blend is done in the shader, so each frame is sampled at one UV.
- The normal atlas is UASTC: sample it without sRGB decoding. The albedo atlas is sRGB ETC1S.

## Budgets and checks

`pnpm assets:check` fails when a fish has no `impostor` block, a file is missing, not in `files[]`,
not the expected codec or transfer function (ETC1S sRGB for albedo, UASTC linear for the normal
atlas), has a different pixel size than `atlasSize`, the pair is over 1 MB per species, or `radius`
does not hold the model bounds around `pivot`. The files also count toward the per-preset download
budget and the 150 MB total.

Regenerate with `pnpm build:assets <fish ids>`; add `--impostor-sheets=<dir>` to write a per-species
and combined contact sheet (albedo left, decoded normals right).
