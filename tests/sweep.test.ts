import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { borderReport, importedBoard, presentationEnvelope } from '../src/core/board';
import { validateShells } from '../src/core/validation';
import { rng, STYLES, type StyleId, VariationEngine } from '../src/core/variations';
import { loadSculpture } from './helpers';

/**
 * Large random sweep of pattern variations (opt-in, a few minutes):
 *   npm run sweep            # 10,000 variations
 *   SWEEP=50000 npm run sweep
 * Every variation gets the complete geometry check and the 2-inch border check.
 * Results are written to test-output/sweep.json.
 */
const runs = Number(process.env.SWEEP ?? 0);

it.runIf(runs > 0)('random sweep of pattern variations', () => {
  const s = loadSculpture();
  const eng = new VariationEngine(s);
  const board = importedBoard(s);
  const out = new Float64Array(s.count * 3);
  const r = rng(Number(process.env.SWEEP_SEED ?? 1829));
  const styles = STYLES.filter((x) => x.id !== 'original').map((x) => x.id as StyleId);
  let bad = 0, minBorder = Infinity, maxMs = 0;
  const codes: Record<string, number> = {};
  const t0 = performance.now();
  for (let n = 0; n < runs; n++) {
    const v = {
      style: styles[n % styles.length],
      intensity: r() < 0.5 ? 1 : r(),
      scale: r() < 0.3 ? Math.round(r()) : r(),
      flow: r() < 0.3 ? 1 : r(),
      seed: Math.floor(r() * 1e6),
    };
    eng.offsets(v, r() * 3600, out);
    const { outer, inner } = s.shellVertices(s.tipsFromOffsets(out));
    const res = validateShells(s, outer, inner);
    maxMs = Math.max(maxMs, res.ms);
    const br = borderReport(board, presentationEnvelope(s, outer, inner));
    minBorder = Math.min(minBorder, br.min);
    if (res.issues.length || br.status !== 'ok') {
      bad++;
      for (const is of res.issues) codes[is.code] = (codes[is.code] ?? 0) + 1;
      if (br.status !== 'ok') codes.border = (codes.border ?? 0) + 1;
    }
  }
  const result = { runs, withIssues: bad, codes, minBorderMm: minBorder, seconds: (performance.now() - t0) / 1000, slowestCheckMs: maxMs };
  mkdirSync('test-output', { recursive: true });
  writeFileSync('test-output/sweep.json', JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result));
  expect(bad).toBe(0);
}, 3_600_000);
