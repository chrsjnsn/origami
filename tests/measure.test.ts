import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { borderReport, importedBoard, presentationEnvelope } from '../src/core/board';
import { validateShells } from '../src/core/validation';
import { STYLE_DEFAULTS, STYLES, type StyleId, VariationEngine } from '../src/core/variations';
import { innerRuleError, loadSculpture } from './helpers';

/** Writes measured numbers used in docs/VERIFICATION.md to test-output/measurements.json. */
it('measure', () => {
  const s = loadSculpture();
  const engine = new VariationEngine(s);
  const original = s.shellVertices(s.tipsFromOffsets(s.originalOffsets));
  const env = presentationEnvelope(s, original.outer, original.inner);
  const b = s.data.evaluatedEnvelopeMm.outer;
  const t0 = performance.now();
  let v = validateShells(s, original.outer, original.inner);
  for (let k = 0; k < 9; k++) v = validateShells(s, original.outer, original.inner);
  const fullMs = (performance.now() - t0) / 10;

  // Pattern statistics at each style's starting settings, compared with the original.
  const stats = (off: Float64Array) => {
    let open = [Infinity, -Infinity], z = [Infinity, -Infinity], step = 0;
    for (let i = 0; i < s.count; i++) {
      const p = -(off[i * 3] + off[i * 3 + 1]) / Math.SQRT2;
      open = [Math.min(open[0], p), Math.max(open[1], p)];
      const h = s.anchors[i * 3 + 2] + off[i * 3 + 2];
      z = [Math.min(z[0], h), Math.max(z[1], h)];
      const c = i % s.cols, r = Math.floor(i / s.cols);
      for (const [dc, dr] of [[1, 0], [0, 1]]) {
        if (c + dc < s.cols && r + dr < s.rows) {
          const j = (r + dr) * s.cols + c + dc;
          step = Math.max(step, Math.hypot(off[i * 3] - off[j * 3], off[i * 3 + 1] - off[j * 3 + 1]));
        }
      }
    }
    return { diagonalLeanMm: open, tipHeightMm: z, neighborLeanStepMm: step };
  };
  const styles: Record<string, unknown> = { original: stats(s.originalOffsets) };
  const off = new Float64Array(s.count * 3);
  let evalMs = 0;
  for (const st of STYLES.filter((x) => x.id !== 'original')) {
    const id = st.id as Exclude<StyleId, 'original'>;
    const vv = { style: id, seed: 1, ...STYLE_DEFAULTS[id] };
    const t1 = performance.now();
    for (let k = 0; k < 100; k++) engine.offsets(vv, k * 0.016, off);
    evalMs = Math.max(evalMs, (performance.now() - t1) / 100);
    engine.offsets(vv, 0, off);
    styles[id] = { ...stats(off), measure: engine.last };
  }
  const t2 = performance.now();
  for (let k = 0; k < 60; k++) s.shellVertices(s.tipsFromOffsets(engine.offsets({ style: 'drift', seed: 1, ...STYLE_DEFAULTS.drift }, k * 0.016, off)));
  const poseMs = (performance.now() - t2) / 60;

  const out = {
    envelopeBrowserMm: env,
    envelopeBlenderEvaluatedMm: b,
    envelopeDiffMm: { minX: env.minX - b[0][0], minY: env.minY - b[0][1], maxX: env.maxX - b[1][0], maxY: env.maxY - b[1][1] },
    borderImported: borderReport(importedBoard(s), env),
    innerRule: innerRuleError(s, original.outer, original.inner),
    validation: { issues: v.issues, pairsTested: v.pairsTested, avgFullCheckMs: fullMs },
    styles,
    variationEvalMsMax: evalMs,
    variationPoseMs: poseMs,
    medianHeight: s.medianHeight,
  };
  mkdirSync('test-output', { recursive: true });
  writeFileSync('test-output/measurements.json', JSON.stringify(out, null, 1));
});
