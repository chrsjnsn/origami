# Developer notes

Units are millimeters. Board coordinates: **X right, Y up, Z outward toward the viewer**; the
mounting plane is z = 0. Blender world coordinates use the same axes (in meters), and three.js world
space is identical, so no axis swaps happen anywhere except the glTF export.

## Canonical data

Each piece `i` (index = row × 29 + col, IDs `C01-R01` … `C29-R18`) has four vertices in the original
Blender order and three stored faces. Roles:

* **corner**: the right-angle base vertex at the lower left of the 50 mm cell
* **right**, **up**: the ends of the base diagonal (hypotenuse)
* **apex**: the tip

Faces: the base (corner, right, up) and two side faces (corner, right, apex) and (corner, up, apex).
The hypotenuse face (right, up, apex) is open and faces the (1, 1) diagonal. Stored windings give
outward normals. World coordinates are evaluated in double precision from the saved float32 local
coordinates and the shared object matrix.

A pose is a set of tip offsets from fixed anchors (the base centroids): `tip_i = anchor_i + offset_i`.
Bases never move. Inner shells always follow the rule below.

## Inner rule

For diagonal endpoints R and U, M = (R + U) / 2 and for every outer vertex V:

```
inner = M + 0.75 (V - M)
```

`Sculpture.shellVertices` applies it every time shells are derived. Both diagonals are collinear and
share their midpoint, and the inner shell always lies inside the outer shell's convex hull.

## Pattern variations (`src/core/variations.ts`)

A variation is `{ style, intensity, scale, flow, seed }` plus a moment `t` (seconds). *Original*
returns the imported offsets. Every other style is a small recipe of wave components, generated
deterministically from the style and seed (mulberry32), and evaluated at the fixed anchors:

```
spacing λ   = 240 · (820 / 240)^scale  mm
phase       φ_c = phase0_c + speed_c · (2π / 24 s) · t
traveling   s = k_c (2π/λ) (q - c)·d_c - φ_c,       u = d_c
ripple      s = k_c (2π/λ) |q - c| - φ_c,           u = (q - c) / sqrt(r² + (λ/6)²)
spiral      ripple + arms · atan2(q - c), faded within 1.2 λ of the center
dune        s ← s - a sin s  (steep lee side)
raw height  z = A · Σ w_c E_c sin s / N,   raw lean ℓ = A · R(τ) Σ w_c E_c cos s · u / N
```

Height and lean come from the same wave, as in the original: tips lean with the slope of the
crest. Every traveling wave is turned at least 25° away from both grid axes (`oblique`): a wave
that runs along a row changes nothing along it, so a whole row of tips would line up. Three slow
fields (each a drifting plane wave, seeded) give the patterns the original's character:

* **Bend** (`q`): the sampling point is displaced by two octaves of warp, a sweep with wavelength
  4.5 λ and amplitude (0.13 + 0.22 · flow) λ and a wobble with wavelength 2.2 λ and amplitude
  (0.03 + 0.12 · flow) λ (Dunes × 1.45, Crosscurrent × 1.25). Fronts always curve; each octave's
  gradient stays below about 0.6 so they meander without folding.
* **Contrast** (`A`): broad areas (700–1400 mm) of strong motion and calmer areas, from
  `A_min` (0.12–0.55 by style) to 1. Blooms get their contrast from their own reach instead.
* **Twist** (`R(τ)`): the lean direction turns by up to ±(15° + 30° · flow) across the board.

Two more layers make sure every row and column shows waves in x, y and z (the user-visible
requirement: no runs of tips lined up in any coordinate):

* **Undertone**: two oblique traveling waves (0.8–1.35 × the main wavenumber), added after the
  contrast field at 0.45 of the pattern's peak, so calm areas keep moving.
* **Ripple**: two fine waves along the two diagonals with fixed wavelengths (205–235 mm and
  165–190 mm, about 4–5 pieces), sampled on the grid itself (not the bent point, so the bend
  cannot stretch them), adding ±8 mm of height and ±8 mm of lean with the slope. Their fixed,
  fine spacing means a smooth slope of the main pattern can never cancel them over a run of
  pieces. They keep their size at every Intensity.

| Style | Recipe |
| --- | --- |
| Drift | two traveling waves near the (1, 1) diagonal, the second longer and turned 15–35° |
| Ripple | a ripple anywhere on the board plus a weaker one in the opposite corner |
| Dunes | a sharp-crested traveling wave near vertical, a long swell along the diagonal, and short cross ripples |
| Crosscurrent | two traveling waves 55–75° apart with unrelated spacings (ratio 1.3–1.6), in opposite directions, woven only in patches |
| Bloom | 3–4 ripples of different strengths with limited reach, spaced at least 0.32 × board width, over a faint swell |
| Spiral | a 2–3 armed spiral near the center |

Why the diagonal matters: the open face of every pyramid faces (1, 1). Leaning a tip toward the
lower left tilts the opening toward the viewer and shows the inside color; leaning toward the upper
right hides it. Styles are therefore oriented so their leans have a large component along that
diagonal, which is what makes colored bands appear (the original works the same way).

### Scaling to the limits

The raw pattern is measured and scaled so that its strongest area reaches the limits, whatever the
style, seed, slider settings or moment. `intensity` below is the pattern strength
`0.5 + 0.5 · slider` (`effectiveIntensity`): the Intensity slider starts at half strength, because
weaker patterns fade into a nearly uniform surface.

```
height  = 49 mm + (intensity · 21 mm / max|z|) · z  +  8 mm · ripple_z  -  intensity · 4 mm · calm
lean    = softcap_66mm( (intensity · 66 mm / max|ℓ|) · ℓ  +  8 mm · ripple_ℓ  +  intensity · 16 mm · calm · (1, 1)/√2 )
```

`calm` (0–1) marks the calm areas; they lean slightly toward the upper right (closed, so they read
dark, like the quiet areas of the original) and sit a little lower.

Neighbor limit: adjacent tips (rows, columns and diagonals, per 50 mm of grid distance) may differ in
lean by at most `intensity · 38 mm` (the original's largest difference is 37.6 mm). Where a pattern
is steeper, only that neighborhood is eased back toward its calm lean: each offending pair lowers a
factor at both ends, the factor is spread to the neighbors (erode, then blur) so the change fades
in, and this repeats up to 6 times. A final global factor then guarantees the limit exactly. Broad
areas therefore keep leans near 66 mm even when a small spot of the pattern is steep.

Finally every tip is softly limited (smooth `tanh` knees, no hard corners): height into
[22, 76] mm and x/y to the board minus its 2-inch border (+1.5 mm for paper thickness).

The neighbor limit was set by sweeping random variations: with the local limiter, 44 mm produced
intersections in 4 of 2,000 variations and 48 mm in 39 of 2,000; 38 mm produced none in 10,000
(see VERIFICATION.md). Heights stay well clear of the checks (the lowest tip is 22 mm; warnings
start at 6 mm).

### Safety net

`makeSafe` runs the complete geometry check (`validateShells`) on a pose and, if anything is
reported (error or warning), bisects a strength factor that scales the pattern toward the calm rest
pose until the pose is clean. The page calls it 250 ms after every change settles and whenever
motion pauses. It is not expected to trigger; a test forces it by loosening the limits.

## Looks and saving (`src/core/look.ts`)

A look is `{ variation, colors: { outer, inner, board }, time }` (colors as sRGB hex). Saved
designs store the look plus a 480 × 320 JPEG thumbnail in `localStorage`
(`ow.designs.v1`, `ow.design.v1.<id>`); the look being edited is kept in `ow.current.v1`. All
reads go through `sanitizeLook`, which clamps and defaults every field.

Paper colors: the hex color is the Principled Base Color. The Blender color ramp spans 0.74× to
1.17× of it and the baked grain multiplies the upper stop by 0.632–1.0, so the three.js material
color is the linear base color × 1.17. `#121416` and `#007aff` reproduce the original ramps exactly.

## Motion and the play bar

While animating, `look.time` advances with real time and the pose is recomputed every frame
(about 2 ms for evaluation plus rebuilding 1,044 thickened shells). `liveTime` is the newest moment
reached; the play bar spans the last 60 seconds before it. Going back, scrubbing and pausing only
change `look.time`, and because the pose depends only on the moment, every earlier moment is
reproduced exactly.

## Viewer

* Pixel ratio: `min(devicePixelRatio, 1.5)` on desktop and `min(devicePixelRatio, 2)` on touch
  devices. It is lowered at most twice (never below 1.0 desktop / 1.5 phones) and only if 90
  consecutive rendered frames average over 45 ms (well below 30 fps); it never goes back up. Earlier versions
  stepped the resolution up and down with the frame rate, which on phones (30 fps Low Power Mode,
  throttled browsers) drove it to 0.75× and reallocated the render targets repeatedly: that was the
  pixelation and blinking reported on iPhone.
* Resizing renders immediately so a cleared canvas is never shown. Height changes under 120 px
  (mobile browser toolbars) do not re-frame the camera.
* The page is fixed and never scrolls; the canvas has `touch-action: none`, so one finger always
  turns the artwork and two fingers zoom and move it (three.js OrbitControls). A two-finger twist
  also turns it (`installTwist`: the change in angle between the fingers × 1.2 goes to
  `controls.rotateLeft`, so clockwise matches dragging right); a pure twist keeps the fingers'
  distance and midpoint, so it does not zoom or move.
* Views: *Front* and *Detail* follow the Blender cameras; *Angled* looks along (0, −1, 1)/√2: the
  artwork tipped back 45°, seen from 45° below its normal, with extra framing margin because
  perspective enlarges the near edge.
* Framing uses screen insets (top bar, buttons, the customize panel or bottom sheet, the play bar)
  so the artwork is centered in the free area; changing insets animates the camera.
* `snapshot(w, h, view)` renders a framed image at an exact size synchronously and restores the
  on-screen view before the browser shows another frame (thumbnails and *Save image*).
* Rendering: `MeshPhysicalMaterial` with the Blender values, an environment map built from the
  world color and the three softboxes, a PCF-shadowed key light (4096², 2048² on phones), GTAO
  ambient occlusion at half resolution (8 samples on phones), linear tone mapping (Blender
  "Standard").

## Design file for Blender (`origami1829-design`, version 1)

The *For Blender* download contains `design.json`, written by `lookDesignFile`: the pose as
`baseOffsets` with no wave sources, the imported board, the geometry check result, plus
`colors` and `look`. `tools/blender/rebuild_design.py` rebuilds the scene; when `colors` is present
it moves each paper material's color ramp to the chosen color (keeping the 0.74× / 1.17× stops) and
gives the board its own material.

```jsonc
{
  "format": "origami1829-design", "version": 1, "name": "Drift", "savedAt": "…",
  "pieceIds": ["C01-R01", …],
  "baseOffsets": [[dx, dy, dz], …],     // tip - base centroid, mm
  "waves": { "sources": [], "phase": 0, "loopTurns": 1 },
  "board": { "width", "height", "centerX", "centerY", "thickness", "topZ", "border", "origin" },
  "pose": { "tips": [[x, y, z], …] },
  "validation": { "passed", "errors", "warnings", "issues", "note" },
  "colors": { "outer": "#121416", "inner": "#ff5a4e", "board": "#5b3f2c" },
  "look": { "variation": { … }, "colors": { … }, "time": 37.5 }
}
```

## GLB mapping

Board point (x, y, z) mm → glTF (x, z, −y) / 1000 m. Blender's importer converts glTF Y-up to
Z-up, so imported objects land at the original Blender coordinates. Nodes are named by piece ID
(`C01-R01`, `C01-R01 INNER 75%`); materials are named after the paper colors.

## Debug hooks

`window.__origami` exposes `viewer`, `app`, `sculpture` and `THREE`. `__origami.app.selfTest()`
checks the pose on screen (inner rule, fixed bases), compares the GPU vertex buffers with geometry
rebuilt from the model, round-trips a GLB export and runs the geometry check. Add `?perf` to the URL
for a frame-time readout.
