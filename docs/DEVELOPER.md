# Developer notes

Units are millimeters. Board coordinates: **X right, Y up, Z outward toward the viewer**; the
mounting plane is z = 0. Blender world coordinates use the same axes (in meters), and three.js world
space is identical, so no axis swaps happen anywhere except the glTF export.

## Canonical data

Each piece `i` (index = row × 29 + col, IDs `C01-R01` … `C29-R18`) has four vertices in the original
Blender order and three stored faces. Roles:

* **corner**: the right-angle base vertex at the lower-left of the 50 mm cell
* **right**, **up**: the ends of the base diagonal (hypotenuse)
* **apex**: the tip

Faces: the base (corner, right, up) and two side faces (corner, right, apex) and (corner, up, apex).
The hypotenuse face (right, up, apex) is open. Stored windings give outward normals (checked by a
test). 520 pieces store the roles as (2, 0, 1, 3); C05-R03 and C05-R05 store them as (2, 3, 0, 1).
Both orders are kept verbatim.

World coordinates are evaluated in double precision from the saved float32 local coordinates and
the shared object matrix (a 90° rotation about X).

## One design state

```
tip_i = anchor_i + base_i + wave_i(phase)
```

* `anchor_i`: fixed base-grid anchor, the centroid of the piece's triangular base (z ≈ 0).
* `base_i`: the editable offsets (a Float64Array of 522 × 3). Initialized from the starting point,
  replaced by *Keep this shape*, changed by brushes.
* `wave_i`: the sum of all wave sources, **sampled at `anchor_i`**, never at a displaced tip.

The snapshot (`DesignSnapshot`) also holds the sources, the global phase, the board, the kept-shape
recipes and the restore reference. Outer shells, inner shells, validation, envelopes, saved files
and exports are all derived from it on demand; nothing else is stored.

*Current sculpture* uses `base = tip_imported − anchor`. *Neutral pattern* uses
`base = (0, 0, h_med − anchor_z)` with `h_med` = the median imported tip height (47.0343 mm).

## Inner rule

For diagonal endpoints R and U, M = (R + U) / 2 and for every outer vertex V:

```
inner = M + 0.75 (V − M)
```

`Sculpture.shellVertices` applies it every time shells are derived (edits, animation frames,
smoothing, undo, load, export). The inner diagonal endpoints are M ± 0.375 (U − R), so both
diagonals are collinear and share their midpoint. Because M lies on the closed outer
tetrahedron and the rule is a contraction toward it, the inner shell always lies inside the outer
shell's convex hull.

## Wave sources

For a source at c with height H, lean L, spacing λ, reach R, speed k and timing offset δ, at global
phase Φ:

```
local phase  φ = k Φ + δ
falloff      E(r) = S(1 − r/R),  S(t) = 6t⁵ − 15t⁴ + 10t³  (E = 1 when R is "whole board")

ripple:      r = |p − c|,  s = 2π r / λ − φ,  u = (p − c) / √(r² + ε²),  ε = λ / 6
traveling:   d = (cos θ, sin θ),  s = 2π (p − c)·d / λ − φ,  u = d,  E uses r = |p − c|

Δz  = E H sin s
Δxy = E L cos s · u
```

`u` fades smoothly to zero at a ripple's center, so there is no division by zero and no flip. The
quintic falloff has zero first and second derivatives at the center and at the reach. Spacing is
limited to at least 200 mm (four grid samples per wavelength on the 50 mm grid). Speeds are
multiples of 0.25, so all sources return to their start after `q` global turns (`loopTurns`); the
scrubber covers that loop and playback wraps the phase inside it. Height and lean ranges are
±30 mm (±60 mm with *Extended ranges*).

The pose depends only on the stored phase, so pause, scrubbing, saving and loading are exact.
*Keep this shape* sets `base ← base + wave(Φ)`, stores the previous base and the sources as a recipe,
and sets the sources' amounts to zero.

## Brushes

Weights come from the fixed anchors: `w_i = S(1 − |anchor_i − c| / R)`.

Time integration is independent of frame rate: a `Stroke` integrates pointer samples in fixed
1/120 s sub-steps, interpolating the brush position inside each sample interval. Holding still keeps
painting (the frame loop feeds the last position). Sampling a stroke at 30, 60 and 144 fps gives the
same result to about 1e-14 mm.

* Height / X lean / Y lean: `offset_axis += sign · 3 · strength · dt · w_i` (mm/s), other axes
  untouched. New values are clamped to the creative bounds (tip height 10–110 mm, lean ±65 mm; or
  3–160 mm and ±110 mm extended) but values already outside the bounds are never snapped.
* Restore: `offset += (1 − e^(−0.5·strength·dt)) w_i (target − offset)`.
* Smooth: see below, blended by `(1 − e^(−0.6·strength·dt)) w_i`.

## Smoothing (reference model)

Per coordinate, minimize

```
Σ_i (x_i − x0_i)²  +  λ Σ_stencils (w (x_a − 2 x_b + x_c))²
```

with second differences along rows and columns (w = 1) and both diagonals (w = 0.35 applied before
squaring). The reference λ is 0.12; the Smoothness control maps 0…1 to λ = 0.12 · 2^(4(s − 0.5)).
The normal equations `(I + λK) x = x0` are solved by Gauss–Seidel with only the pieces under the brush
as unknowns; all other pieces are held fixed as boundary values, so nothing outside the footprint
moves. The operator is validated by reproducing the earlier X/Y refinement: solving the global
problem from the manual original tips with λ = 0.12 and ±5 mm bounds matches the imported tips to
7.3e-5 mm.

## Validation

`validateShells` checks design surfaces and reports; it never edits.

* Finite coordinates; base vertices bit-identical to the import; inner rule within 1e-9 mm.
* Tip height: error at z ≤ 0, warning under 6 mm.
* Side faces: error below 2 mm² area, warning when an angle is under 4°.
* Crossings: every pair of pieces within 3 cells whose bounding boxes overlap is tested with all
  6 × 6 triangle pairs (outer and inner faces of both). Two triangles cross when an edge of one
  passes strictly through the interior of the other (barycentric margin 1e-7, plane tolerance
  1e-6 mm). Contacts at shared grid corners and coplanar base contacts do not count.

A complete check covers 1,949 candidate pairs in about 7–15 ms.

## Presentation thickness

`solidify.ts` replicates Blender's *Simple* Solidify without even offset: each vertex moves along its
angle-weighted vertex normal. Outer shells (offset +1) keep the design surface and add 0.45 mm
outward; inner shells (offset −1) extend 0.25 mm inward, so the blue base sits above the black base
while both design triangles stay on z = 0. Each shell becomes 12 flat-shaded triangles (both sides
plus rims on the open edges). The board's front face is at z = −0.55 mm, below the outer stock
(−0.45 mm), and every surface is single-sided with outward normals, so coincident base planes
never z-fight. The envelope of this geometry matches Blender's evaluated envelope within 0.05 mm
(the difference is Blender's 0.055 mm bevel).

**Fit board with 2-inch border**: `width = maxX − minX + 2 × 50.8`, likewise for height, centered on the
envelope of the thickened outer and inner shells.

## Rendering

* `MeshPhysicalMaterial` with the Blender values: roughness 0.88 (black) and 0.72 (blue),
  specular intensity 0.44 (Blender *Specular IOR Level* 0.22), base color the upper stop of the color
  ramp multiplied by the baked grain (0.632–1.0, the ramp's proportional range), and the grain as a
  bump map with box-projected UVs.
* Lighting: an environment map built from the Blender world color and the three disk softboxes at
  their true directions and angular sizes (PMREM), three directional lights at the Blender light
  positions (the key light casts a 4096² PCF shadow), a lit backdrop plane, GTAO ambient occlusion
  at half resolution, and linear tone mapping (Blender "Standard"), which keeps #007AFF saturated.
* The balance was tuned by comparing 10th, 50th and 90th percentile colors of black and blue pixels
  with the reference renders (see VERIFICATION.md).
* Dynamic resolution: the pixel ratio starts at min(devicePixelRatio, 1.5) and steps by 0.25
  between 1.0 (0.75 on touch devices) and that maximum based on the measured frame interval.

## Design file (`origami1829-design`, version 1)

```jsonc
{
  "format": "origami1829-design", "version": 1, "name": "…", "savedAt": "…",
  "units": "mm", "coordinateSystem": "…",
  "source": { "file": "origami1829-final-vision.blend", "sha256": "239c2e87…" },
  "startingPoint": "current" | "neutral",
  "pieceIds": ["C01-R01", …],               // 522, row-major
  "baseOffsets": [[dx, dy, dz], …],         // committed offsets from the base centroids
  "reference": { "label": "…", "offsets": [[…], …] },
  "waves": { "sources": [{ "kind": "ripple", "x", "y", "height", "lean", "spacing",
             "reach": 900 | "board", "direction", "speed", "phaseOffset", "enabled" }],
             "phase": 2.3, "loopTurns": 1 },
  "board": { "width", "height", "centerX", "centerY", "thickness", "topZ", "border", "origin" },
  "kept": [{ "id", "at", "label", "sources": […], "phase", "baseBefore": [[…], …] }],
  "pose": { "tips": [[x, y, z], …] },       // evaluated outer tips, for checking and other tools
  "validation": { "passed", "errors", "warnings", "issues": […], "note" }
}
```

Loading rebuilds the pose from `baseOffsets`, `waves` and the phase, then compares it with
`pose.tips` and reports any difference.

## GLB mapping

Board point (x, y, z) mm → glTF (x, z, −y) / 1000 m. Blender's importer converts glTF Y-up to
Z-up, so imported objects land at the original Blender coordinates with identity transforms.
Nodes are named by piece ID (`C01-R01`, `C01-R01 INNER 75%`) and carry `extras` (piece ID, role,
apex index, diagonal indices, diagonal midpoint).

## Blender reconstruction

`tools/blender/rebuild_design.py` rebuilds the scene from `sculpture.json`,
`sculpture-blender.json`, `presentation.json` and a design file. For unedited tips it reuses the
saved float32 local coordinates bit for bit; edited tips go through the inverse object matrix in
double precision. Inner shells are always recomputed with the 75% rule. `--compare other.blend`
reports vertex differences against another file.

## Debug hooks

`window.__origami` exposes `model`, `viewer`, `app` and `sculpture`. `__origami.app.selfTest()`
checks the live pose (inner rule, fixed bases), compares the GPU vertex buffers with geometry rebuilt
from the model, and round-trips a GLB export. Add `?perf` to the URL for a frame-time readout.
