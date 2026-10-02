# Verification results

Measured on 2026-09-29 on an Apple M2 Pro (macOS, Chromium in the Claude desktop browser pane),
Node 22, Blender 5.0.1, three.js 0.186. Reproduce with `npm test`, `npm run verify-blender`,
`npm run sweep` and the browser checks below (`window.__origami.app.selfTest()` in the page).

## Source file

| Check | Result |
| --- | --- |
| Source | `origami1829-final-vision.blend`, SHA-256 `239c2e87a4bdb0f3ddbc199f5d5931c55cb99f9b9bf873b1cf07e56c3451ca01` |
| Unchanged after asset preparation, rebuilds and all tests | Yes (hash identical) |
| Pieces | 522 outer + 522 inner, 29 × 18 grid, 50 mm pitch; every shell 4 vertices, 3 faces, hypotenuse open |
| Saved inner shells vs `M + 0.75 (V − M)` | max 7.8e-5 mm (float32 storage in the .blend) |
| Board | 1575.95 × 1040.56 × 6 mm (62 1/16 × 40 15/16 × 1/4 in), 2-inch border on every side |
| Browser envelope vs Blender's evaluated envelope | within 0.031–0.046 mm (Blender's 0.055 mm bevel is not modeled) |
| Tip heights | 26.99–70.91 mm, median 47.034 mm |

## Geometry limits of the pattern variations

| Check | Result |
| --- | --- |
| Random sweep, `npm run sweep` (10,000 variations: all six styles, half at intensity 1, 30% at the scale and flow extremes, random seeds and moments up to one hour) | **0 variations with any error or warning**; smallest board border 51.93 mm (the 2-inch border is 50.8 mm) |
| Margin: the same sweep with the neighbor lean limit raised from 38 to 44 / 48 mm | intersections in 4 / 39 of 2,000 variations (so the chosen limit keeps a margin) |
| Sweep inside `npm test` | 600 variations, 0 issues, border > 50.8 mm |
| Limits at the strongest settings (every style, scale 0 and 1, flow 1) | tips 22–76 mm high, lean ≤ 66 mm, all tips inside the border |
| Bases and inner shells for every style | bases 0 mm change; inner rule exact (< 1e-9 mm) |
| Lowest Intensity (every style) | half strength: strongest lean still > 25 mm |
| Waves along every row and column (every style, starting and random settings including all extremes) | straight runs average < 3%, worst < 12% (test) |
| Boldness (every style, seeds 1–3, starting settings) | strongest lean > 40 mm; at least 20% of the board calm (lean < 22 mm); heights spanning > 30 mm |
| Safety net | leaves safe poses unchanged (strength 1); with deliberately loosened limits it found a clean strength below 1 |
| Motion | fastest tip speed below 40 mm/s at the strongest settings; the pose depends only on the moment |

Strongest lean at each style's starting settings, seeds 1–5 (the original: about 69 mm along the
diagonal), with the local neighbor limiter: Drift 57–61 mm, Ripple 58–61, Dunes 53–62,
Crosscurrent 55–61, Bloom 62–63, Spiral 58–61. Before this change (one global scale factor, no
contrast), the same measure was 31–56 mm and most of each board sat at a similar, middling lean.

Pattern character at each style's starting settings, compared with the original. "Diagonal lean"
(seed 1) is the lean along the (1, 1) diagonal, which decides how much of the inside paper shows
(negative = closed, positive = open). "Straight runs" is how often 5 neighboring tips line up
within 3 mm: tip x along columns / tip y along rows / height along rows / height along columns,
averaged over seeds 1–12 (lower is more wave-like):

| | Diagonal lean (mm) | Tip height (mm) | Largest neighbor lean step (mm) | Straight runs (%) |
| --- | --- | --- | --- | --- |
| Original | −69 to 46 | 27–71 | 37.6 | 0.7 / 1.1 / 2.0 / 6.7 |
| Drift | −62 to 49 | 24–71 | 34.6 | 1.8 / 1.3 / 1.6 / 1.5 |
| Ripple | −53 to 59 | 23–71 | 35.6 | 1.1 / 1.0 / 1.9 / 1.9 |
| Dunes | −55 to 39 | 26–69 | 35.8 | 1.3 / 1.2 / 1.6 / 1.6 |
| Crosscurrent | −41 to 51 | 27–73 | 35.7 | 0.8 / 0.7 / 1.3 / 1.5 |
| Bloom | −49 to 51 | 25–74 | 37.5 | 0.9 / 0.8 / 1.5 / 1.2 |
| Spiral | −60 to 47 | 24–71 | 35.6 | 1.6 / 1.7 / 1.8 / 1.8 |

Before the undertone, ripple and oblique-wave changes, the same straight-run averages reached 10 /
10 / 30 / 7% for Dunes and 8 / 9 / 16 / 16% for Crosscurrent, with single variations up to 46%.
Across random settings including every slider extreme (40 variations per style), the average is
now 1.5–1.9% and the worst single measure 8% (the original's worst is 6.7%).

## Model tests (`npm test`: 27 tests pass, 1 opt-in sweep skipped)

Import and topology, the inner rule against the saved .blend, the supporting data files, the
envelope and border, the geometry check (clean import, crafted crossing found), *Original* showing
the import exactly, determinism, the lowest intensity at half strength, the calm rest pose at strength 0, boldness and contrast, waves along every row and column, fixed bases and exact inner
shells for every style, slow motion, the limits at the strongest settings, the 600-variation sweep,
the safety net, reading untrusted saved looks, palettes, imperial formatting, the Blender design
file (rebuilds the exact pose, 0 mm, with colors) and the GLB (pose within 2e-4 mm, topology,
colored materials).

## Blender round trip (`npm run verify-blender`: 8 checks pass)

| Check | Result |
| --- | --- |
| Original rebuilt from its design file, compared with the original .blend | 1,044 objects; outer shells **0 mm**; bases 0 mm; inners 1.2e-4 mm (float32) |
| Drift variation (coral inside, walnut board, mid-motion) rebuilt | bases 0 mm; tips 1.4e-4 mm; inner rule 1.3e-4 mm; board 1575.95 × 1040.56 mm |
| Colors in the rebuilt scene | inside and board color ramps equal the chosen colors × 1.17 (< 0.01) |
| GLB import into Blender | 522 pieces, topology preserved, tips and 75% rule within 1.4e-4 mm |

## Browser

| Check | Result |
| --- | --- |
| Main page | the artwork as made in black and #007AFF; logo and title only, info button, Front / Angled / Detail, Customize |
| Angled view | the artwork tipped back 45° (seen from 45° below its normal); whole board framed on a 370 × 863 phone screen |
| Info panel | slides in from the left; on wide screens the artwork moves aside; measurements in inches |
| Self-test, main page | inner rule 0 mm, bases 0 mm, GPU buffers vs model 6.1e-5 mm, GLB vs pose 6.0e-5 mm, geometry check 0 errors / 0 warnings |
| Self-test, customize page (Spiral at intensity 1, scale 0, flow 1) | the same results, safety strength 1 |
| Styles | each checked visually in a clean 1200 × 820 render (Drift, Ripple, Dunes, Crosscurrent, Bloom, Spiral) |
| Colors | swatches and custom colors apply immediately to the pyramids, inside paper and board; style previews follow |
| Motion and play bar | time advances in real time; back 5 s moves exactly 5 s; paused time holds (0 s drift); Live returns to the newest moment and resumes |
| Saving | *Save design* stores the look and a thumbnail and lists it; *Save image* gives a 3000 × 2000 PNG of the front view; *For Blender* gives a zip with 7 files (downloads intercepted in the page) |
| Phone layout (375 × 812) | whole board framed on the main page; customize panel as a bottom sheet that collapses to its header; play bar above it; artwork centered in the free space |
| Touch (simulated) | one-finger drag turns the artwork; a two-finger clockwise twist of 34° turned it 41° in the same direction as dragging right, with no zoom; the page never scrolls; `touch-action: none` on the canvas |
| Blue base of low pyramids | the blue base's top surface sits 0.25 mm above the black base on every piece (before: −0.15 to +0.10 mm on low pyramids, so black flickered through the blue); compared in renders of the lowest pyramids before and after |
| Self-test at extreme settings (Spiral scale 0, Bloom scale 1, Crosscurrent scale 0.3, all at intensity 1 and flow 1) | 0 errors, 0 warnings; bases 0 mm; inner rule 0 mm; GPU vs model 6.1e-5 mm |
| Rendering cost, 1536 × 1152 buffer (pixel ratio 1.5) | 8.2 ms per frame with the GPU synchronized; pose update while animating 2.0 ms |
| Production build | `npm run build` succeeds (868 kB JS, 227 kB gzipped) |

## iPhone issues addressed (not verified on a device)

The reported pixelation, blinking and erratic movement on iPhone (Brave) match three behaviors of
the previous version, all removed:

1. Dynamic resolution followed the frame interval, so a 30 fps cap (Low Power Mode, browser
   throttling) pushed the pixel ratio down to 0.75. Phones now render at 2× and never step up and
   down.
2. Every resolution step and every browser-toolbar resize reallocated the render targets and
   re-framed the camera; the canvas could show an empty frame in between. Resizes now render
   immediately, toolbar-sized height changes do not re-frame, and the resolution changes at most
   twice.
3. The page scrolled under the viewer and split vertical swipes (page) from sideways swipes
   (artwork). The page is now fixed and all touches go to the artwork.

## Not verified

* A physical iPhone or other phone, Safari and Firefox (only Chromium with emulated viewports and
  simulated touch).
* Two-finger pinch, pan and twist on real touch hardware.
* Fabrication of variations: paper thickness, glue tabs, unfolding and cutting templates are out of
  scope.
