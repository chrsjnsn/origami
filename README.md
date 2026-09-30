# Origami Waves

A website for **Origami Waves**, a paper artwork of 522 folded pyramids in matte black on a
29 × 18 grid, each open on one side to reveal a smaller pyramid of vivid blue (#007AFF) paper
inside at exactly 75% scale.

* **Main page:** the artwork in 3-D, exactly as saved in `origami1829-final-vision.blend`, with
  nothing else in the way. The **i** button (bottom left) slides in the details and measurements
  (in inches). **Customize** (bottom right) opens the second page.
* **Customize page:** choose paper colors, pick a pattern style and shape it with three sliders,
  let the pattern move slowly like a live stream (pause, go back, save the moment), and save
  designs, images and Blender files.

Built with [three.js](https://threejs.org) (WebGL 2), TypeScript and Vite. Everything runs in the
browser; nothing is sent anywhere.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. For a production build (static files in `dist/`, host anywhere):

```bash
npm run build
```

The live site is deployed on Vercel from the `main` branch. Requirements: Node 20+ and a browser
with WebGL 2. Blender (4.2+, tested with 5.0.1) is only needed to regenerate assets or to verify
the Blender files.

## Using the site

**Viewing.** Drag with one finger (or the mouse) or twist two fingers to turn the artwork, scroll
or pinch to zoom, right-drag or slide two fingers to move it. *Front* and *Detail*
recreate the Blender cameras; *Angled* shows the artwork tipped back 45°, as if leaning back on an
easel, where the relief reads best. The page never scrolls, so touch gestures always go to the
artwork.

**Customize** (the page's address ends in `#customize`, so the browser's back button returns to
the main page):

| Control | What it does |
| --- | --- |
| **Colors** | Pyramids (outside paper), Inside (the nested paper), Board. Each has a set of swatches plus a custom color picker. |
| **Pattern style** | *Original* (the artwork as made), *Drift*, *Ripple*, *Dunes*, *Crosscurrent*, *Bloom*, *Spiral*. The small previews show each style in your colors. |
| **Intensity** | Subtle to bold: how far the pyramids rise, fall and lean. The lowest setting is half strength, so there is always a clear pattern. |
| **Scale** | Fine to broad: the distance between wave crests. Broad waves let the tips lean farthest. |
| **Flow** | Gentle to swirling: how much the wave fronts bend and the leans twist. |
| **Shuffle** | A new variation of the style (new positions, angles and timing). |
| **Animate** | Starts the slow, continuous motion and shows the play bar. |
| **Undo / Redo / Reset** | Step through changes, or go back to the original artwork. |

The **play bar** works like a live stream: pause, jump back 5 seconds, drag through the last
minute, return to *Live*, or press the bookmark to save the moment you are looking at.

**Save design** keeps the look (colors, style, sliders, moment) in this browser under *My
designs*, with a thumbnail; tap one to reopen it. The current look is also remembered between
visits. **Save image** renders a 3000 × 2000 PNG of the front view. **For Blender** downloads a
zip with a `.glb` (File › Import › glTF 2.0) and a script that rebuilds the full scene with
materials, lights and cameras in your colors (instructions in the zip's README).

### How the patterns are made

Like the original, every style mixes strong areas, where tips reach far over and rise or drop,
with calmer areas that lean slightly closed and sit a little lower, so the strong areas stand out.
Wave fronts always bend a little (more with *Flow*), and the lean direction turns gradually across
the board. Each pattern is measured and scaled until its strongest area reaches the limits below,
which keeps every variation bold.

Waves run along every row and column: no wave may travel along a row or column (every one is at
least 25° off both), a gentle undertone of two more oblique waves runs everywhere, and a fine
ripple along the two diagonals (about 4–5 pieces per wave, ±8 mm in height and ±8 mm in lean) keeps
every tip's x, y and height changing from piece to piece. Measured over runs of 5 neighboring
pieces, tips line up (within 3 mm) about 2% of the time, as in the original.

### Geometry limits

Every variation stays within limits taken from the original artwork, so pyramids are never too
short, never fall toward the board, never touch their neighbors and never reach into the 2-inch
border of the board:

* tip height 22 to 76 mm (the original: 27 to 71 mm), resting at 49 mm
* sideways lean up to 66 mm (the original reaches about 69 mm)
* neighboring tips differ in lean by at most 38 mm (the original: 37.6 mm); where a pattern is
  steeper, only that spot is eased back, smoothly
* all tips inside the board's 2-inch border

These limits are part of how the patterns are built. On top of that, after each change the
complete geometry check runs; if it ever found anything, the pattern would be toned down until
clean. In 10,000 random variations at the most extreme settings it never had to (see
[docs/VERIFICATION.md](docs/VERIFICATION.md)).

## Project layout

```
index.html                 page markup (main page, info panel, customize panel, play bar)
src/core/                  geometry model, no DOM (tested in Node)
  sculpture.ts             canonical data, immutable original, inner rule
  variations.ts            pattern styles, sliders, geometry limits, safety net
  look.ts                  colors, palettes, saved-look format
  exportLook.ts            design file for the Blender rebuild script
  validation.ts board.ts solidify.ts design.ts waves.ts
  glb.ts exportGeometry.ts GLB writer and 3-D export
src/render/viewer.ts       three.js viewer, studio lighting, framing, snapshots
src/ui/                    page controller, storage, units, zip writer
public/assets/             prepared assets (generated, see below)
public/downloads/          rebuild_design.py for the Blender download
tools/                     asset preparation and Blender verification
assets-src/                read-only copy of the source .blend and supporting files
tests/                     Vitest suite and fixtures
docs/                      developer notes and verification results
```

## Asset preparation

`npm run prepare-assets` regenerates everything in `public/assets/` from the `.blend`:

1. Hashes `assets-src/origami1829-final-vision.blend` (a read-only copy of the original; pass
   `-- --blend path/to/file.blend` for another file).
2. Opens it in background Blender (`--factory-startup`, never saved) and runs
   `tools/blender/export_canonical.py`, which writes:
   * `sculpture.json`: per-piece IDs, grid cell, the 4 vertices in Blender order (mm, board
     coordinates, double precision), the 3 stored faces, vertex roles (corner, right, up, apex),
     diagonal midpoint M, base centroid, board, stock thicknesses, stats, and Blender's evaluated
     envelope.
   * `sculpture-blender.json`: raw local coordinates, object and mesh names, and custom properties
     for exact reconstruction.
   * `presentation.json`: materials (principled values, noise, bump and color ramp), lights,
     cameras, world, board and render settings.
   * `textures/paper-grain.png`: a tileable 512 px grain baked to approximate the procedural noise
     (used as albedo variation and bump).
   * `assets-src/prep-report.json`: verification of the import (inner rule, midpoints, borders).
3. Copies the rebuild script to `public/downloads/` and confirms the source hash is unchanged.

Set `BLENDER=/path/to/blender` if Blender is not in the default macOS location or on `PATH`.

## Verification

```bash
npm test
```

```bash
npm run verify-blender
```

```bash
npm run sweep
```

`npm test` checks the import, the geometry limits (including a 600-variation random sweep), the
saved-look format and the exports. `npm run verify-blender` rebuilds the original and a colored
variation in Blender and imports the `.glb`. `npm run sweep` checks 10,000 random variations
(about 2 minutes; `SWEEP=50000 npm run sweep` for more). Results are in
[docs/VERIFICATION.md](docs/VERIFICATION.md); the mathematics is in
[docs/DEVELOPER.md](docs/DEVELOPER.md).

## Limitations

* The variations are previews of possible versions, not fabrication plans: paper thickness, glue
  tabs and unfolding are not modeled, and the existing cutting templates describe only the
  original.
* The browser recreates the Cycles look with image-based lighting, a soft shadow map and ambient
  occlusion, tuned against the reference renders; it is not path traced. Custom colors use the
  same paper grain and lighting, so very light papers look as they would under that studio light.
* Tested in Chromium on desktop and in phone and tablet viewports with simulated touch. Not yet
  tried on a physical iPhone, in Safari or in Firefox.
