import { it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { presentationEnvelope, borderReport, importedBoard, fitBoard } from '../src/core/board';
import { GridStencils, REFERENCE_LAMBDA, solveSmoothing } from '../src/core/smoothing';
import { StudioModel } from '../src/core/studio';
import { defaultBrush } from '../src/core/brushes';
import { validateShells } from '../src/core/validation';
import { loadJson, loadSculpture, innerRuleError } from './helpers';

/** Writes measured numbers used in docs/VERIFICATION.md to test-output/measurements.json. */
it('measure', () => {
  const s = loadSculpture();
  const m = new StudioModel(s);
  const p = m.getPose();
  const env = presentationEnvelope(s, p.outer, p.inner);
  const b = s.data.evaluatedEnvelopeMm.outer;
  const t0 = performance.now();
  let v = validateShells(s, p.outer, p.inner);
  for (let k = 0; k < 9; k++) v = validateShells(s, p.outer, p.inner);
  const fullMs = (performance.now() - t0) / 10;
  const t1 = performance.now();
  for (let k = 0; k < 60; k++) { m.setPhase(k * 0.1); m.getPose(); }
  const poseMs = (performance.now() - t1) / 60;
  // Reproduce the previous X/Y refinement from the manual original with the same operator.
  const blender = loadJson('public/assets/sculpture-blender.json');
  const grid = new GridStencils(s.cols, s.rows);
  const n = s.count;
  const x0 = new Float64Array(n * 3);
  for (const bp of blender.pieces) {
    const i = s.ids.indexOf(bp.id);
    for (let k = 0; k < 3; k++) x0[i * 3 + k] = bp.outerProps.wave_original_tip_mm[k] - s.anchors[i * 3 + k];
  }
  const x = x0.slice();
  const lo = x0.map((v) => v - 5), hi = x0.map((v) => v + 5);
  const all = Array.from({ length: n }, (_, i) => i);
  for (const axis of [0, 1]) solveSmoothing(grid, x, x0, all, axis, REFERENCE_LAMBDA, 4000, { lo, hi });
  let repro = 0;
  for (let i = 0; i < n; i++) for (const k of [0, 1]) repro = Math.max(repro, Math.abs(x[i * 3 + k] - s.originalOffsets[i * 3 + k]));
  const fitted = fitBoard(importedBoard(s), env);
  // Same stroke sampled at different frame rates.
  const stroke = (fps: number) => {
    const sm = new StudioModel(s);
    sm.beginStroke(defaultBrush('height'), 300, 300, 0);
    for (let t = 1 / fps; t <= 1 + 1e-9; t += 1 / fps) sm.strokeTo(300 + 500 * t, 300 + 200 * t, t);
    sm.endStroke();
    return sm.getPose().tips.slice();
  };
  const r30 = stroke(30), r60 = stroke(60), r144 = stroke(144);
  let d3060 = 0, d60144 = 0, peak = 0;
  for (let j = 0; j < r30.length; j++) {
    d3060 = Math.max(d3060, Math.abs(r30[j] - r60[j]));
    d60144 = Math.max(d60144, Math.abs(r60[j] - r144[j]));
    peak = Math.max(peak, Math.abs(r60[j] - s.anchors[j] - s.originalOffsets[j]));
  }
  const out = {
    strokeFrameRate: { maxChangeMm: peak, diff30vs60Mm: d3060, diff60vs144Mm: d60144 },
    xyRefinementReproductionMaxErrorMm: repro,
    fitBoardFromBrowserEnvelopeMm: [fitted.width, fitted.height],
    envelopeBrowserMm: env,
    envelopeBlenderEvaluatedMm: b,
    envelopeDiffMm: { minX: env.minX - b[0][0], minY: env.minY - b[0][1], maxX: env.maxX - b[1][0], maxY: env.maxY - b[1][1] },
    borderImported: borderReport(importedBoard(s), env),
    innerRule: innerRuleError(s, p.outer, p.inner),
    validation: { issues: v.issues, pairsTested: v.pairsTested, avgFullCheckMs: fullMs },
    poseEvalMs: poseMs,
    medianHeight: s.medianHeight,
  };
  mkdirSync('test-output', { recursive: true });
  writeFileSync('test-output/measurements.json', JSON.stringify(out, null, 1));
});
