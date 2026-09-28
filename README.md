# Origami 1829: viewer and customization studio

A single-page website for **Origami 1829**, a paper sculpture of 522 open, matte-black pyramids
on a 29 × 18 grid (50 mm pitch), each nesting a vivid blue (#007AFF) shell at exactly 75% scale.
The top of the page is a 3-D viewer that opens on the sculpture exactly as saved in
`origami1829-final-vision.blend`. Below it is a studio for shaping your own version with wave
sources and brushes that move the real folded geometry, with a live geometry check, undo, local
saving, and exports that open in Blender.

Built with [three.js](https://threejs.org) (WebGL 2), TypeScript and Vite. No server is involved:
everything runs and stays in the browser.

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

Requirements: Node 20+ and a browser with WebGL 2 (current Chrome, Edge, Safari or Firefox).
Blender (4.2+, tested with 5.0.1) is only needed to regenerate assets or rebuild designs as `.blend`.

## Using the site

**Viewing.** Drag to orbit, scroll or pinch to zoom, right-drag or two-finger drag to pan.
*Front*, *Angled* and *Detail* recreate the three Blender cameras; the circular arrow resets the
camera. On phones, swipe sideways to turn the artwork and vertically to scroll the page. After you
edit, a toggle switches the viewer between **Original** and **Your design**.

**Customize** pins the artwork at the top of the screen and opens the studio below it. The tool
strip holds the tools, wave playback, undo/redo, *hold to compare* with the original, the
geometry status, and *Done*.

### Wave sources

1. Choose **Waves**. One ripple sits at the center with zero influence, so entering the tool
   changes nothing.
2. Raise **Height** (mm up and down) and/or **Lean** (mm sideways; negative leans the other way).
   Height and lean share the wave's **Spacing** (distance between crests) and timing.
3. Drag the round handle on the artwork to move the source, or click/tap the board to place it.
   **Reach** limits how far the ripple travels; *Reach the whole board* removes the limit.
4. **+ Traveling wave** adds straight wave fronts. Drag its small second handle, or use
   **Direction**, to aim it.
5. **Play** animates the actual geometry; **Speed** sets how fast each source moves
   (negative = inward/backward, 0 = standing). The scrubber shows one full cycle.
6. **Pause** freezes the exact shape. **Keep this shape** commits it as the new base for
   brushes. The wave settings move to *Kept shapes*, where *Return to settings* brings them back.

Several sources combine. Changing any setting recomputes from the base, so nothing drifts.

### Brushes

| Brush | What it changes |
| --- | --- |
| **Height** | Z only: raise toward you (+Z) or lower toward the board (−Z) |
| **X lean** | X only: lean right (+X) or left (−X) |
| **Y lean** | Y only: lean up (+Y) or down (−Y) |
| **Smooth** | Softens abrupt steps between neighbors; choose all axes or one. Broad crests survive. |
| **Restore** | Blends back toward the chosen baseline (kept shape/starting point, original, or neutral) |

Paint with one finger or the left mouse button. The soft circle on the board is the footprint; its
arrow or ⊙/⊗ symbol shows the direction in board coordinates even when the camera is rotated.
**Size** is the footprint diameter, **Strength** the rate (mm per second at the center for the axis
brushes). One continuous stroke is one undo step.

Camera while painting: right-drag orbits, the wheel zooms, hold **Space** to move the view, or use
two fingers on a touch screen (this cancels the stroke in progress). Hold **⌥ Option/Alt** to
reverse a brush; **[** and **]** change its size.

Keyboard: `W` waves, `H` `X` `Y` `S` `R` brushes, `V` view, `P` play/pause, `K` keep,
hold `C` compare, `1` `2` `3` views, `0` reset camera, `⌘Z` / `⇧⌘Z` undo/redo, `Esc` leave.

### Starting point, checks, board

* **Starting point**: *Current sculpture* (the import) or *Neutral pattern* (every tip centered
  over its base at the imported median height, 47.03 mm). Switching is undoable; the imported
  original is never modified.
* **Extended ranges** unlock bolder heights, leans and wave amounts.
* **Geometry check** runs continuously (at most every 0.35 s while animating) and completely before
  every save or export. Problems are flagged on the artwork in red (errors) and amber (warnings)
  and listed with a *Show* button. Nothing is corrected silently.
* **Board** stays fixed during animation. The panel shows the remaining border on each side and
  warns when a design uses the 2-inch border or leaves the board. **Fit board with 2-inch border**
  resizes it around the full tip envelope, including presentation paper thickness, and the new size
  is saved with the design.

### Save and export

* **Save in this browser**: named designs with thumbnails (localStorage). Your unsaved work is also
  kept as a draft and offered as *Resume last session*.
* **Design file (.json)**: the complete design (starting point, committed offsets, wave sources and
  phase, kept shapes, board, evaluated tip positions, check result). *Open design file…* loads it
  and rebuilds the exact pose from the settings.
* **Image (.png)**: a clean render (about 3000 px on the long side) of the current view.
* **3-D model (.glb)**: every outer and inner shell as its own object (4 vertices, 3 faces, the open
  hypotenuse face kept open), plus the board. Blender's *File › Import › glTF 2.0* places it at the
  original coordinates. Optionally includes the presentation paper thickness.
* **Blender package (.zip)**: design file, rebuild script and canonical data. Inside the unzipped
  folder run:

  ```bash
  blender -b --factory-startup -P rebuild_design.py -- --design design.json --out my-design.blend
  ```

  This recreates the scene as in the original file: object names, vertex order, fixed bases, the
  inner shells rebuilt with the 75% rule, Solidify/Bevel presentation modifiers, procedural
  materials, board, lights and cameras.

## Project layout

```
index.html                 page markup
src/core/                  geometry model, no DOM (tested in Node)
  sculpture.ts             canonical data, immutable original, inner rule
  design.ts                design state, undo history, design file format
  studio.ts                every editing action (StudioModel)
  waves.ts brushes.ts smoothing.ts validation.ts board.ts solidify.ts
  glb.ts exportGeometry.ts GLB writer and 3-D export
src/render/                three.js viewer, studio lighting, overlays
src/ui/                    page controller, storage, zip writer
public/assets/             prepared assets (generated, see below)
public/downloads/          rebuild_design.py for the Blender package
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

`npm test` runs 33 tests on the model (import, inner rule, waves, brushes, smoothing, validation,
save/load, GLB export) and writes measured numbers to `test-output/measurements.json`.
`npm run verify-blender` rebuilds an unedited and an edited design in Blender, compares every shell
with the original file, and imports the GLB export into Blender. Measured results, including
in-browser checks of rendering, touch, performance and exports, are in
[docs/VERIFICATION.md](docs/VERIFICATION.md). The mathematics is in
[docs/DEVELOPER.md](docs/DEVELOPER.md).

## Limitations

* This is a design preview, not a fabrication check. Intersection checks use the design surfaces;
  paper thickness, glue tabs and unfolding are not modeled, and the existing cutting templates do
  not describe edited designs.
* The browser recreates the Cycles look with image-based lighting, a soft shadow map and ambient
  occlusion, tuned by matching pixel statistics of the reference renders. It is not path traced.
  The paper grain is a baked approximation of Blender's noise, not the identical function.
* The 0.055 mm edge bevel is not rendered, so the browser's presentation envelope differs from
  Blender's by at most 0.05 mm (the imported board shows at least 50.75 mm of border).
* The viewer uses a narrow perspective camera; the Blender reference renders are orthographic.
* Undo history lasts for the session; kept shapes and everything needed to reproduce a design are
  saved in the design file. Browser storage typically holds a few dozen designs.
* Tested in Chromium (desktop, and phone/tablet viewports with synthetic touch events). Not yet
  tried on physical phones or in Safari and Firefox.
