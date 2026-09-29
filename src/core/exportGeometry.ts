/**
 * 3-D export of the current pose as GLB for Blender.
 *
 * Board coordinates (mm, X right, Y up, Z outward) are written as glTF (x, z, -y) in meters.
 * Blender's glTF importer converts Y-up to Z-up, so the imported objects land at exactly the
 * original Blender world coordinates (meters, board in the XY plane, Z outward).
 *
 * Each piece keeps its 4 vertices in the original Blender order and its 3 stored faces
 * (the open hypotenuse face stays open). Inner shells are the exact 75% copies.
 */

import type { BoardSettings } from './board';
import { type GlbDocument, type GlbNode, writeGlb } from './glb';
import type { PaperColors } from './look';
import type { Sculpture } from './sculpture';
import { FLOATS_PER_SHELL, writeThickShell } from './solidify';

export const MATERIAL_COLORS = {
  // Midpoints of the Blender color ramps (linear RGB).
  outer: [0.0058, 0.0067, 0.0077] as [number, number, number],
  inner: [0.0, 0.186, 0.955] as [number, number, number],
};

export function toGltf(x: number, y: number, z: number, out: Float32Array, o: number): void {
  out[o] = x / 1000;
  out[o + 1] = z / 1000;
  out[o + 2] = -y / 1000;
}

export interface ExportOptions {
  includePresentation: boolean;
  designName: string;
  /** Paper colors (sRGB hex). Defaults to the original black and blue. */
  colors?: PaperColors;
}

/** sRGB hex to linear RGB. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

export function buildDesignGlb(
  sculpture: Sculpture,
  outer: Float64Array,
  inner: Float64Array,
  board: BoardSettings,
  opts: ExportOptions,
): Uint8Array {
  const doc: GlbDocument = {
    materials: opts.colors
      ? [
          { name: `Outer paper ${opts.colors.outer}`, color: hexToLinear(opts.colors.outer), roughness: 0.88 },
          { name: `Inner paper ${opts.colors.inner}`, color: hexToLinear(opts.colors.inner), roughness: 0.72 },
          { name: `Board ${opts.colors.board}`, color: hexToLinear(opts.colors.board), roughness: 0.88 },
        ]
      : [
          { name: 'Matte black dyed cardboard', color: MATERIAL_COLORS.outer, roughness: 0.88 },
          { name: 'Vibrant message blue paper - sRGB 007AFF', color: MATERIAL_COLORS.inner, roughness: 0.72 },
          { name: 'Matte black board', color: MATERIAL_COLORS.outer, roughness: 0.88 },
        ],
    meshes: [],
    nodes: [],
    roots: [],
    extras: {
      design: opts.designName,
      units: 'Blender meters after import (board coordinates)',
      innerRule: sculpture.data.innerRule,
      sourceSha256: sculpture.data.source.sha256,
    },
  };
  const addNode = (n: GlbNode) => {
    doc.nodes.push(n);
    return doc.nodes.length - 1;
  };
  const outerChildren: number[] = [];
  const innerChildren: number[] = [];
  const idx = new Uint32Array(9);

  for (let i = 0; i < sculpture.count; i++) {
    for (let k = 0; k < 9; k++) idx[k] = sculpture.faces[i * 9 + k];
    for (const [src, list, suffix, material] of [
      [outer, outerChildren, '', 0],
      [inner, innerChildren, ' INNER 75%', 1],
    ] as const) {
      const pos = new Float32Array(12);
      for (let v = 0; v < 4; v++) {
        const o = i * 12 + v * 3;
        toGltf(src[o], src[o + 1], src[o + 2], pos, v * 3);
      }
      doc.meshes.push({ name: sculpture.ids[i] + suffix, positions: pos, indices: idx.slice(), material });
      list.push(
        addNode({
          name: sculpture.ids[i] + suffix,
          mesh: doc.meshes.length - 1,
          extras: {
            piece_id: sculpture.ids[i],
            role: material === 0 ? 'outer' : 'inner',
            apex_index: sculpture.roles[i * 4 + 3],
            diagonal_indices: [sculpture.roles[i * 4 + 1], sculpture.roles[i * 4 + 2]],
            diagonal_midpoint_mm: Array.from(sculpture.midpoints.subarray(i * 3, i * 3 + 3)),
          },
        }),
      );
    }
  }

  const collections = [
    addNode({ name: 'Outer shells (design surfaces)', children: outerChildren }),
    addNode({ name: 'Inner shells 75% (design surfaces)', children: innerChildren }),
  ];

  // Board box.
  const x0 = board.centerX - board.width / 2, x1 = board.centerX + board.width / 2;
  const y0 = board.centerY - board.height / 2, y1 = board.centerY + board.height / 2;
  const z1 = board.topZ, z0 = board.topZ - board.thickness;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const bpos = new Float32Array(24);
  corners.forEach((c, k) => toGltf(c[0], c[1], c[2], bpos, k * 3));
  // Faces wound counterclockwise seen from outside in board coordinates. The (x, z, -y)
  // mapping is a proper rotation, so the winding stays outward in glTF.
  const bidx = new Uint32Array([
    4, 5, 6, 4, 6, 7, // front (+z)
    0, 3, 2, 0, 2, 1, // back
    0, 1, 5, 0, 5, 4, // bottom
    2, 3, 7, 2, 7, 6, // top
    1, 2, 6, 1, 6, 5, // right
    3, 0, 4, 3, 4, 7, // left
  ]);
  doc.meshes.push({ name: 'Backing board', positions: bpos, indices: bidx, material: 2 });
  collections.push(
    addNode({
      name: 'Backing board - 2 inch border',
      mesh: doc.meshes.length - 1,
      extras: { width_mm: board.width, height_mm: board.height, thickness_mm: board.thickness, border_mm: board.border },
    }),
  );

  if (opts.includePresentation) {
    const p = sculpture.data.presentation;
    for (const [src, spec, material, name] of [
      [outer, { thickness: p.outerThicknessMm, offset: 1 as const }, 0, 'Presentation stock - outer 0.45 mm'],
      [inner, { thickness: p.innerThicknessMm, offset: -1 as const }, 1, 'Presentation stock - inner 0.25 mm'],
    ] as const) {
      const tmpPos = new Float64Array(FLOATS_PER_SHELL);
      const tmpNor = new Float64Array(FLOATS_PER_SHELL);
      const pos = new Float32Array(FLOATS_PER_SHELL * sculpture.count);
      const nor = new Float32Array(FLOATS_PER_SHELL * sculpture.count);
      for (let i = 0; i < sculpture.count; i++) {
        writeThickShell(src, i * 12, sculpture.faces, i * 9, spec, tmpPos, tmpNor, 0);
        for (let j = 0; j < FLOATS_PER_SHELL; j += 3) {
          toGltf(tmpPos[j], tmpPos[j + 1], tmpPos[j + 2], pos, i * FLOATS_PER_SHELL + j);
          toGltf(tmpNor[j] * 1000, tmpNor[j + 1] * 1000, tmpNor[j + 2] * 1000, nor, i * FLOATS_PER_SHELL + j);
        }
      }
      doc.meshes.push({ name, positions: pos, normals: nor, material });
      collections.push(addNode({ name, mesh: doc.meshes.length - 1, extras: { presentation_only: true } }));
    }
  }

  doc.roots.push(addNode({ name: `Origami Waves - ${opts.designName}`, children: collections }));
  return writeGlb(doc);
}
