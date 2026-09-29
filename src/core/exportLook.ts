/**
 * Turns a look (variation, moment, colors) into the design file that the Blender rebuild script
 * reads (format origami1829-design v1), plus the look itself so it can be reopened later.
 */

import { importedBoard } from './board';
import { type DesignFile, type DesignSnapshot, serializeDesign, type ValidationSummary } from './design';
import type { Look, PaperColors } from './look';
import type { Sculpture } from './sculpture';
import { validateShells } from './validation';

export interface LookDesignFile extends DesignFile {
  /** Paper colors (sRGB hex) for the outer pyramids, inner pyramids and board. */
  colors: PaperColors;
  /** The customize-page settings that produced this pose. */
  look: Look;
}

/** Design file for the pose `offsets` (tip - anchor) of a look. */
export function lookDesignFile(sculpture: Sculpture, look: Look, offsets: Float64Array, name: string): LookDesignFile {
  const snap: DesignSnapshot = {
    startingPoint: look.variation.style === 'original' ? 'current' : 'neutral',
    base: offsets.slice(),
    reference: offsets.slice(),
    referenceLabel: name,
    sources: [],
    phase: 0,
    board: importedBoard(sculpture),
    kept: [],
  };
  const { outer, inner } = sculpture.shellVertices(sculpture.tipsFromOffsets(offsets));
  const r = validateShells(sculpture, outer, inner);
  const errors = r.issues.filter((i) => i.severity === 'error').length;
  const validation: ValidationSummary = {
    checkedAt: new Date().toISOString(),
    passed: errors === 0,
    errors,
    warnings: r.issues.length - errors,
    issues: r.issues.map((i) => ({ code: i.code, severity: i.severity, pieces: i.pieces.map((p) => sculpture.ids[p]), message: i.message })),
    note: 'Complete geometry check of the design surfaces when the file was made.',
  };
  return { ...serializeDesign(sculpture, snap, name, undefined, validation), colors: { ...look.colors }, look: structuredClone(look) };
}
