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
spiral      ripple + arms · atan2(q - c), faded near the center
dune        s ← s - a sin s  (steep lee side)
height      z = Σ w_c E_c sin s / N,   lean ℓ = Σ w_c E_c cos s · u / N
tip         (anchor_xy + L ℓ,  46 mm + H z)
```

`q` is the anchor bent by the flow warp: two slow sine fields displace the sampling point by up to
`0.2 λ · flow` (warp wavelength 2.3 λ, drifting once a minute). `E_c` is a quintic falloff for
blooms, `N` the total weight (blooms normalize by local coverage). Height and lean come from the
same wave, as in the original: tips lean with the slope of the crest.

| Style | Recipe |
| --- | --- |
| Drift | two traveling waves near the (1, 1) diagonal, the second longer and turned 12–24° |
| Ripple | a ripple anywhere on the board plus a weaker one in the opposite corner |
| Dunes | a sharp-crested traveling wave near vertical plus a long swell along the diagonal |
| Crosscurrent | two traveling waves about 90° apart (near X and Y), running in opposite directions |
| Bloom | 3–5 ripples with limited reach, spaced at least 0.3 × board width, over a faint swell |
| Spiral | a 2–4 armed spiral near the center |

Why the diagonal matters: the open face of every pyramid faces (1, 1). Leaning a tip toward the
lower left tilts the opening toward the viewer and shows the inside color; leaning toward the upper
right hides it. Styles are therefore oriented so their leans have a large component along that
diagonal, which is what makes colored bands appear (the original works the same way).

### Geometry limits

Amplitudes are derived so the pattern cannot produce geometry problems:

```
H = intensity · 24 mm
L = intensity · min(62 mm, 56 mm / (k_max · warp_gain · (2π/λ) · 50 mm))
```

The second term bounds how much the lean can change between adjacent pieces (50 mm apart) to about
56 mm; `k_max` is the style's highest local wavenumber and `warp_gain = 1 + 2π · 0.2 · flow / 2.3`
accounts for the flow warp compressing waves locally. After that, every tip is softly limited
(smooth `tanh` knees, no hard corners): height into [22, 76] mm, lean magnitude to 62 mm, and x/y
to the board minus its 2-inch border (+1.5 mm for paper thickness).

The constants were set by sweeping random variations: a neighbor step of 66 mm produced intersections
in 17 of 2,000 variations; 56 mm produced none in 10,000 (see VERIFICATION.md). Heights stay well
clear of the checks (the lowest tip is 22 mm; warnings start at 6 mm).

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
  turns the artwork and two fingers zoom and move it (standard three.js OrbitControls).
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
