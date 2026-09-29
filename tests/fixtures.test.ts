import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { importedBoard } from '../src/core/board';
import { buildDesignGlb } from '../src/core/exportGeometry';
import { lookDesignFile } from '../src/core/exportLook';
import { ORIGINAL_LOOK, sanitizeLook } from '../src/core/look';
import { VariationEngine } from '../src/core/variations';
import { loadSculpture } from './helpers';

/**
 * Writes the files used by tools/verify-blender-roundtrip.mjs, with the same code as the
 * site's "For Blender" download:
 *   test-output/design-original.json  the artwork as made
 *   test-output/design-edited.json    a Drift variation in coral and walnut, mid-motion
 *   test-output/design-edited.glb     the same pose as GLB (with paper thickness and colors)
 */
it('writes round-trip fixtures', () => {
  const s = loadSculpture();
  const engine = new VariationEngine(s);
  mkdirSync('test-output', { recursive: true });
  writeFileSync('test-output/design-original.json', JSON.stringify(lookDesignFile(s, ORIGINAL_LOOK, s.originalOffsets.slice(), 'Original')));

  const look = sanitizeLook({
    variation: { style: 'drift', seed: 1829, intensity: 0.95, scale: 0.45, flow: 0.5 },
    colors: { outer: '#121416', inner: '#ff5a4e', board: '#5b3f2c' },
    time: 37.5,
  });
  const off = engine.offsets(look.variation, look.time);
  writeFileSync('test-output/design-edited.json', JSON.stringify(lookDesignFile(s, look, off, 'Drift fixture')));
  const { outer, inner } = s.shellVertices(s.tipsFromOffsets(off));
  writeFileSync(
    'test-output/design-edited.glb',
    buildDesignGlb(s, outer, inner, importedBoard(s), { includePresentation: false, designName: 'Drift fixture', colors: look.colors }),
  );
});
