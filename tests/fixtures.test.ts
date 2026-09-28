import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { defaultBrush } from '../src/core/brushes';
import { serializeDesign } from '../src/core/design';
import { buildDesignGlb } from '../src/core/exportGeometry';
import { StudioModel } from '../src/core/studio';
import { loadSculpture } from './helpers';

/**
 * Writes design files used by tools/verify-blender-roundtrip.mjs:
 *   test-output/design-original.json  the unedited import
 *   test-output/design-edited.json    waves + kept shape + brush strokes + fitted board
 *   test-output/design-edited.glb     the edited pose as GLB
 */
it('writes round-trip fixtures', () => {
  const s = loadSculpture();
  mkdirSync('test-output', { recursive: true });
  const original = new StudioModel(s);
  writeFileSync('test-output/design-original.json', JSON.stringify(serializeDesign(s, original.snap, 'Original import')));

  const m = new StudioModel(s);
  const src = m.addSource('ripple', 500, 600);
  m.updateSource(src.id, { height: 12, lean: 9, spacing: 500 });
  const t = m.addSource('travel', 1200, 300);
  m.updateSource(t.id, { height: 5, lean: 7, direction: 210 });
  m.setPhase(2.3);
  m.keepShape();
  m.beginStroke({ ...defaultBrush('leanX'), radius: 220 }, 900, 500, 0);
  for (let k = 1; k <= 30; k++) m.strokeTo(900 + k * 5, 500, k / 60);
  m.endStroke();
  m.beginStroke({ ...defaultBrush('smooth'), radius: 260 }, 400, 300, 0);
  for (let k = 1; k <= 30; k++) m.strokeTo(400, 300, k / 60);
  m.endStroke();
  m.fitBoard();
  writeFileSync('test-output/design-edited.json', JSON.stringify(serializeDesign(s, m.snap, 'Edited fixture')));
  const p = m.getPose();
  writeFileSync('test-output/design-edited.glb', buildDesignGlb(s, p.outer, p.inner, m.snap.board, { includePresentation: false, designName: 'Edited fixture' }));
});
