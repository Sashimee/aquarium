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
  "grid": 9,            // frames per side; frames = grid * grid (odd, see below)
  "frameSize": 128,     // pixels per frame side
  "atlasSize": 1152,    // grid * frameSize, both axes
  "pivot": [x, y, z],   // fish-space point every frame is centred on (bounding-box centre), metres
  "radius": 0.0436,     // half-extent of every frame in metres, a sphere around pivot (7 percent margin)
  "albedo":      { "file": "...", "bytes": 0, "sha256": "...", "codec": "etc1s" },
  "normalDepth": { "file": "...", "bytes": 0, "sha256": "...", "codec": "uastc" }
}
```

## The quad

The quad is `2 * radius` metres on a side, centred on `pivot`, the same size for every view, so the
silhouette does not jump between frames. It is oriented **by the camera**, not by a frame: with
`dCamera` = unit vector from the pivot to the camera in fish space (camera position through the
inverse fish transform, minus pivot, normalised), build `viewBasis(dCamera)` and place the corners at

```
pivot + radius * (+-1 * right + +-1 * up)      // fish space, then the fish's world transform
```

so the quad faces the camera with fish-space up as screen up (`reference = +Y`; at the poles it is
`+Z`, so the roll is undefined within 1e-6 of +-Y and does not matter there). The wave bend is
applied to the quad afterwards.

## Why a full octahedron

Fish are seen from below as often as from above: a camera at mid-tank looks up at everything in the
top half, and fish pitch while climbing and diving. A hemi-octahedron would need a second lookup for
those views. Cost of the full sphere: half the frames show the underside. At 9 x 9 frames of 128 px
the pair is about 0.5 MB per species.

Odd grid: `grid = 9` makes +Y, -Y, the four horizontal axes (side, head-on, tail-on) exact frames,
so the most common view of a fish, side-on, is a single frame with no blending. An even grid would
put no frame on any axis.

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

## Sampling a frame (the part that is easy to get wrong)

The four blended frames were rendered in four different bases, and around the poles those bases are
rotated by up to 180 degrees against each other (`viewBasis` of the -Y corner frame (0,0) has
`right = +X`, its neighbour (1,0) has `right = -X`, and (0,1) has `right = +Z`). **Each frame needs its
own UV.** Sampling all four at the same UV blends three differently rotated copies of the fish.

For a point `q` on the camera quad (`q = radius * (sx * right + sy * up)` of `viewBasis(dCamera)`,
`sx, sy` in [-1, 1], relative to the pivot) and the frame `(i, j)` with `dFrame = cellDirection(i, j, grid)`
and `viewBasis(dFrame)` = `(rightK, upK)`:

```
t   = dot(q, dFrame) / max(dot(dCamera, dFrame), 0.25)   // the view ray is -dCamera
x   = q - t * dCamera                                    // ray hit on the frame's plane
lu  = clamp(0.5 + 0.5 * dot(x, rightK) / radius, inset, 1 - inset)
lv  = clamp(0.5 - 0.5 * dot(x, upK)    / radius, inset, 1 - inset)
uv  = ((i + lu) / grid, (j + lv) / grid)                 // v = 0 at the first stored row
```

`framePointUv` in `octahedral.ts` is this, and its test checks that a point on the plane shared by two
neighbouring frames lands on the texel each of them stores for it. Port it unchanged. The perspective
camera is treated as parallel along `-dCamera` (the bake is orthographic); the cap on the denominator
only matters for frames more than about 75 degrees from the camera, which have almost no weight.

`inset = 0.5 * 2^maxMipLevel / frameSize` (`frameInset`): half a texel of the coarsest sampled level,
1/32 of a frame for level 3 at 128 px. The clamp stops linear filtering and mips from reaching into
the neighbouring frame. The silhouette rim (7 percent radius margin, about 4 px at 128 px) is empty by
construction, so the clamp only ever lands on empty texels.

Blend weights come from `blendCells(dCamera, grid)`: the four frames around `directionToUv(dCamera)`,
bilinear weights summing to 1. Blend albedo and normal with those weights, and coverage (alpha) too.

## Channels

| file              | R                    | G                | B             | A                                 |
| ----------------- | -------------------- | ---------------- | ------------- | --------------------------------- |
| `impostor_albedo` | base colour R (sRGB) | G                | B             | coverage 0..1 (anti-aliased edge) |
| `impostor_normal` | normal x in view     | normal y in view | fin mask 0..1 | depth                             |

- Albedo is unlit base colour (texture times material factor, multiplied in linear light and stored
  sRGB), so the shader relights it. Colour is bled up to 4 px past the silhouette and filled with the
  frame's mean colour beyond that, so filtering and mips never pull black into the edge; use alpha,
  not colour, to find the silhouette.
- Normal is the interpolated **vertex** normal, flipped to face that frame's camera on thin
  double-sided fins (so `dot(n, dFrame) >= 0`), stored in the **frame's own view basis**:
  `R = 0.5 + 0.5 * dot(n, rightK)`, `G = 0.5 + 0.5 * dot(n, upK)`, and
  `dot(n, dFrame) = sqrt(1 - x^2 - y^2)` with `x, y = 2 * (R, G) - 1`. The vector is continuous over
  each frame, so linear filtering and mips are safe. After the lookup, rotate it back to fish space
  with that frame's `viewBasis` (`decodeViewNormal`), blend the four, normalise, then rotate by the
  fish's world rotation before lighting. The tangent-space normal map is not baked.
- Fin mask is `_FIN_MASK` on fin vertices (`_FIN_ID > 0`) and 0 on the rigid body.
- Depth is `0.5 + 0.5 * dot(p - pivot, dFrame) / radius` per frame: 0.5 on the frame's plane through
  the pivot, larger towards that frame's camera. Blend it with the same weights and use
  `(depth - 0.5) * 2 * radius` metres, along `dCamera`, to push the fragment depth out of the quad
  for sorting against decor. It is not used to shift the UV (no parallax step).
- Outside the silhouette (`alpha = 0`) normal, mask and depth are bled 4 px like colour, then become
  neutral: the frame's own view direction (R = G = 0.5), mask 0, depth 0.5.

## Sampling notes

- Mips are generated across the whole atlas. Cap the sampled level at `log2(frameSize) - 4` (level 3
  for 128 px frames) and clamp every frame UV by `frameInset` for that level.
- Use `LinearFilter`. The 4-frame blend is done in the shader, with one UV per frame as above.
- The normal atlas is UASTC: sample it without sRGB decoding. The albedo atlas is sRGB ETC1S.

## Budgets and checks

`pnpm assets:check` fails when a fish has no `impostor` block, a file is missing, not in `files[]`,
not the expected codec or transfer function (ETC1S sRGB for albedo, UASTC linear for the normal
atlas), has a different pixel size than `atlasSize`, the pair is over 1 MB per species, or `radius`
does not hold the model bounds around `pivot`. The files also count toward the per-preset download
budget and the 150 MB total.

Regenerate with `pnpm build:assets <fish ids>`; add `--impostor-sheets=<dir>` to write a per-species
and combined contact sheet (albedo left, decoded fish-space normals right).
