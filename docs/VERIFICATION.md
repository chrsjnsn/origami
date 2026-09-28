# Verification results

Measured on 2026-09-25 on an Apple M2 Pro (macOS, Chromium in the Claude desktop browser pane),
Node 22.23, Blender 5.0.1, three.js 0.186. Reproduce with `npm test`, `npm run verify-blender`,
and the browser checks described below (`window.__origami.app.selfTest()` in the page).

## Source file

| Check | Result |
| --- | --- |
| Source | `origami1829-final-vision.blend`, SHA-256 `239c2e87a4bdb0f3ddbc199f5d5931c55cb99f9b9bf873b1cf07e56c3451ca01` |
| Unchanged after export, rebuilds and all tests | Yes (hash identical in `assets-src/` and the original folder) |
| Pieces | 522 outer + 522 inner, 29 × 18 grid, 50 mm pitch, IDs match grid positions |
| Topology | Every shell: 4 vertices, 3 faces, hypotenuse face open, outward windings |
| Saved inner shells vs `M + 0.75 (V − M)` | max 7.8e-5 mm (float32 storage in the .blend) |
| Diagonal midpoints, outer vs inner | max 5.3e-6 mm |
| Board (mesh) | 1575.952 × 1040.555 × 6.000 mm, front face at z = −0.55 mm |
| Border from Blender's evaluated envelope | left 50.800, right 50.800, bottom 50.800, top 50.800 mm |
| Tip heights | 26.99–70.91 mm, median 47.034 mm |
| Lean from base centroid | X −49.7 to +60.8 mm, Y −39.1 to +53.0 mm |
| Cross-check with `scene-details.json` anchors and `xy-adjustments.json` tips | all within 0.001 mm |

## Model (Node, `npm test`: 33 tests pass)

| Requirement | Result |
| --- | --- |
| Initial state equals the import | tips within 1e-12 mm; all 2,088 outer vertices within 1e-12 mm |
| All 522 bases fixed | 0 mm change after waves, every brush, smoothing, restore, undo, load |
| All 522 inners exact 75% copies | error 0 mm (double precision), collinearity 2e-21, after every operation |
| Axis brushes | Height changes only Z, X lean only X, Y lean only Y, and only inside the footprint |
| Smooth on one axis | other axes bit-identical; pieces outside the footprint bit-identical |
| Smoothing keeps broad crests | local bending energy drops on all axes; height correlation with the original > 0.9 |
| Smoothing model vs the previous refinement | X/Y refinement reproduced to 7.3e-5 mm (λ 0.12, ±5 mm, 0.35 diagonals) |
| Stroke frame-rate independence | 30 vs 60 vs 144 fps: 7e-15 / 2e-14 mm difference |
| One stroke = one undo step | yes; undo and redo restore bit-identical offsets |
| Waves sample fixed anchors, no drift | 20 setting changes then back: 0 mm difference, base untouched |
| Zero influence on entering the wave tool | 0 mm change |
| Play/pause determinism | pose depends only on phase; one loop later < 1e-9 mm; revisit 0 mm |
| Keep this shape | committed pose identical (0 mm); returning to the recipe < 1e-9 mm |
| Neutral starting point | every tip over its base centroid at 47.034 mm; undo restores the import exactly |
| Save/load | JSON round trip rebuilds the pose with 0 mm difference |
| GLB export vs pose | < 2e-4 mm (float32 meters), stored face order preserved |
| Validation | import: 0 errors, 0 warnings; crafted crossings and tips below the board detected |
| Board fit | 50.800 mm on all four sides after fitting; saved and reloaded with the design |
| Browser envelope vs Blender evaluated envelope | within 0.031–0.046 mm (Blender bevel not modeled) |
| Imported board with the browser envelope | minimum border 50.754 mm, status OK |
| Full geometry check | 1,949 neighbor pairs, 13 ms (Node), 7–15 ms (browser) |

## Blender round trip (`npm run verify-blender`: 7 checks pass)

| Check | Result |
| --- | --- |
| Unedited design rebuilt, compared with the original .blend | 1,044 objects; outer shells **0 mm**; bases 0 mm; inners 1.2e-4 mm (float32) |
| Edited design (2 wave sources, kept shape, lean and smooth strokes, fitted board) | bases 0 mm; tips 1.4e-4 mm; inner rule 1.3e-4 mm; fitted board 1579.42 × 1046.26 mm |
| GLB import into Blender | 522 pieces, topology and face order preserved, tips and 75% rule 1.4e-4 mm, bases 4e-12 mm |

## Browser

| Check | Result |
| --- | --- |
| First view | the unedited import; *Original / Your design* toggle appears only after edits |
| Viewport GPU buffers vs model | 6.1e-5 mm (float32), including while comparing with the original |
| In-page GLB export vs pose | 6.0e-5 mm |
| Wave UI | Height/Lean sliders drive the source (one coalesced undo step); Play animates geometry; Pause holds the pose (0 mm drift); a fresh model at the same phase matches exactly |
| Keep this shape (button) | 0 mm change; recipe listed under *Kept shapes* |
| Mouse strokes | Height stroke changed only Z on 95 pieces; X lean in the angled view changed only X (all +X) |
| Direction handle drag | traveling wave rotated to 90°, center unchanged, crest lines follow |
| Touch (synthetic pointer events) | one finger paints; a second finger cancels the stroke and restores the pose exactly with no history entry; a one-finger stroke is one undo step |
| Compare (hold) | viewport shows the original; release restores the design bit-identically |
| Save in this browser / reopen / delete | reopened pose 0 mm from the stored pose; thumbnail stored; delete asks first |
| Exports (downloads intercepted in page) | JSON 178 kB (reloads with 0 mm difference), GLB 821 kB, Blender zip 1.36 MB with 6 files; PNG 3000 × 2945 px in 0.6 s, viewer resolution restored afterward |
| Issue highlighting | a deliberate collision (extended ranges) flagged 36 pieces in red/amber with outlines and a listed explanation; the design was not altered |
| Responsive layout | checked at 1440 × 900, 768 × 1024, 721 × 863 and 375 × 812 |
| Production build | `npm run build` bundle loads; self-test passes |
| Asset preparation is reproducible | re-running `npm run prepare-assets` produced byte-identical assets |

### Rendering match with the reference renders

Pixel-color medians (sRGB) of blue and black pixels in the browser's Detail and Front views, which
follow the Blender camera directions (perspective instead of orthographic, so framing is similar
rather than identical). 10th and 90th percentiles were compared too:

| View | Blue median, browser vs reference | Black median, browser vs reference |
| --- | --- | --- |
| Detail | (22, 117, 242) vs (27, 132, 254) | (42, 43, 45) vs (38, 40, 44) |
| Front | (38, 141, 255) vs (38, 144, 250) | (43, 44, 46) vs (43, 44, 47) |

Blue stays saturated (no drift toward periwinkle), black cardboard reads as graded dark grays with
visible folds, and the blue disappears behind black faces as the camera moves. Front, angled and
close-up views were inspected visually.

### Performance (1440 × 900 window, M2 Pro)

| Measure | Result |
| --- | --- |
| Wave evaluation (2 sources, 522 tips) | 0.09 ms |
| Wave + rebuilding 1,044 thickened shells | 3.0 ms per animation frame |
| GPU frame, 2160 × 1350 (pixel ratio 1.5), shadows + half-resolution AO | 11.0 ms front, 12.6 ms detail |
| Same without AO | 4.0 ms |
| Original setting (pixel ratio 2, full-resolution AO) | 27.4 ms, which is why the defaults changed |
| Geometry during playback | checked at most every 0.35 s; complete check on save/export |

Frame times were measured by forcing GPU completion with `readPixels` after each frame.

## Not verified

* Physical phones and tablets (only emulated viewports and synthetic touch events).
* Safari and Firefox.
* Two-finger orbit and pinch on real touch hardware (standard three.js OrbitControls behavior).
* Fabrication: paper thickness, glue tabs, unfolding and cutting templates are out of scope.
