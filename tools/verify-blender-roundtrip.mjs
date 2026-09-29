#!/usr/bin/env node
/**
 * End-to-end Blender verification.
 *
 *   npm run verify-blender
 *
 * 1. Writes design fixtures with the same code the browser uses (tests/fixtures.test.ts).
 * 2. Rebuilds the unedited and an edited design (a pattern variation in custom colors) in
 *    Blender with rebuild_design.py and compares every shell with the original .blend.
 * 3. Imports the edited GLB export into Blender and compares it with the design file.
 * Results are written to test-output/blender-roundtrip.json.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const original = join(root, 'assets-src/origami1829-final-vision.blend');

const sh = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write((r.stdout || '') + (r.stderr || ''));
    throw new Error(`${cmd} failed`);
  }
  return r.stdout;
};
const report = (out, tag) => JSON.parse(out.split('\n').find((l) => l.startsWith(tag)).slice(tag.length + 1));

sh('npx', ['vitest', 'run', 'tests/fixtures.test.ts']);
const results = {};
for (const name of ['original', 'edited']) {
  const out = sh(blender, [
    '-b', '--factory-startup', '--python-exit-code', '1', '-P', 'tools/blender/rebuild_design.py', '--',
    '--design', `test-output/design-${name}.json`, '--out', `test-output/rebuilt-${name}.blend`, '--compare', original,
  ]);
  results[`rebuild_${name}`] = report(out, 'REBUILD_REPORT');
}
results.glb_edited = report(
  sh(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '-P', 'tools/blender/verify_glb.py', '--',
    '--glb', 'test-output/design-edited.glb', '--design', 'test-output/design-edited.json']),
  'GLB_REPORT',
);

const o = results.rebuild_original, e = results.rebuild_edited, g = results.glb_edited;
// The edited fixture uses coral inside paper on a walnut board (see tests/fixtures.test.ts).
const srgbToLinear = (hex) => [1, 3, 5].map((k) => {
  const c = parseInt(hex.slice(k, k + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const colorErr = (upper, hex) => Math.max(...srgbToLinear(hex).map((c, k) => Math.abs(c * 1.17 - upper[k])));
const checks = {
  'unedited rebuild: outer shells identical to the original': o.compare.outerMaxDiffMm === 0,
  'unedited rebuild: inner shells within float32 of the original (< 0.001 mm)': o.compare.innerMaxDiffMm < 1e-3,
  'edited rebuild: base vertices unchanged': e.compare.baseMaxDiffMm === 0,
  'edited rebuild: tips match the design (< 0.001 mm)': e.tipMaxErrorMm < 1e-3,
  'edited rebuild: inner = M + 0.75 (V - M) (< 0.001 mm)': e.innerRuleMaxErrorMm < 1e-3,
  'GLB import: 522 pieces, topology preserved': g.piecesFound === 522 && g.topologyPreserved,
  'GLB import: tips and 75% rule (< 0.001 mm)': g.tipMaxErrorMm < 1e-3 && g.innerRuleMaxErrorMm < 1e-3,
  'edited rebuild: chosen paper colors applied (inside and board)':
    colorErr(e.materials.inner.rampUpperLinear, '#ff5a4e') < 0.01 && colorErr(e.materials.board.rampUpperLinear, '#5b3f2c') < 0.01,
};
results.checks = checks;
writeFileSync(join(root, 'test-output/blender-roundtrip.json'), JSON.stringify(results, null, 2));
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
if (Object.values(checks).some((v) => !v)) process.exit(1);
