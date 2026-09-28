/**
 * Backing board: stays fixed during animation; can be refitted with a 2-inch border measured
 * from the full tip envelope including presentation thickness.
 */

import type { Sculpture } from './sculpture';
import { FLOATS_PER_SHELL, writeThickShell } from './solidify';

export const TWO_INCH_BORDER_MM = 50.8;
/** Tolerance for reporting border use; covers the Blender bevel the browser does not model. */
export const BORDER_TOLERANCE_MM = 0.5;

export interface BoardSettings {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  thickness: number;
  /** z of the board's front surface (mm). */
  topZ: number;
  border: number;
  origin: 'imported' | 'fitted';
}

export interface Envelope {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function importedBoard(sculpture: Sculpture): BoardSettings {
  const b = sculpture.data.board;
  return {
    width: b.widthMm,
    height: b.heightMm,
    centerX: b.center[0],
    centerY: b.center[1],
    thickness: b.thicknessMm,
    topZ: b.topZMm,
    border: TWO_INCH_BORDER_MM,
    origin: 'imported',
  };
}

export function emptyEnvelope(): Envelope {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
}

export function envelopeOf(positions: ArrayLike<number>, count: number, env = emptyEnvelope()): Envelope {
  for (let j = 0; j < count * 3; j += 3) {
    const x = positions[j], y = positions[j + 1], z = positions[j + 2];
    if (x < env.minX) env.minX = x;
    if (x > env.maxX) env.maxX = x;
    if (y < env.minY) env.minY = y;
    if (y > env.maxY) env.maxY = y;
    if (z < env.minZ) env.minZ = z;
    if (z > env.maxZ) env.maxZ = z;
  }
  return env;
}

/** Envelope of the thickened outer and inner shells for the given shell vertices. */
export function presentationEnvelope(
  sculpture: Sculpture,
  outer: Float64Array,
  inner: Float64Array,
  scratch = new Float64Array(FLOATS_PER_SHELL),
): Envelope {
  const env = emptyEnvelope();
  const p = sculpture.data.presentation;
  for (let i = 0; i < sculpture.count; i++) {
    writeThickShell(outer, i * 12, sculpture.faces, i * 9, { thickness: p.outerThicknessMm, offset: 1 }, scratch, null, 0);
    envelopeOf(scratch, FLOATS_PER_SHELL / 3, env);
    writeThickShell(inner, i * 12, sculpture.faces, i * 9, { thickness: p.innerThicknessMm, offset: -1 }, scratch, null, 0);
    envelopeOf(scratch, FLOATS_PER_SHELL / 3, env);
  }
  return env;
}

export interface BorderReport {
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** Smallest remaining border (mm). */
  min: number;
  status: 'ok' | 'border-used' | 'exceeds';
  message: string;
}

export function borderReport(board: BoardSettings, env: Envelope): BorderReport {
  const left = env.minX - (board.centerX - board.width / 2);
  const right = board.centerX + board.width / 2 - env.maxX;
  const bottom = env.minY - (board.centerY - board.height / 2);
  const top = board.centerY + board.height / 2 - env.maxY;
  const min = Math.min(left, right, bottom, top);
  const sides = { left, right, bottom, top };
  const worst = (Object.keys(sides) as (keyof typeof sides)[]).reduce((a, b) => (sides[a] <= sides[b] ? a : b));
  let status: BorderReport['status'] = 'ok';
  let message = `Full ${fmt(board.border)} mm border on every side.`;
  if (min < 0) {
    status = 'exceeds';
    message = `The design extends ${fmt(-min)} mm past the ${worst} edge of the board.`;
  } else if (min < board.border - BORDER_TOLERANCE_MM) {
    status = 'border-used';
    message = `The design uses ${fmt(board.border - min)} mm of the ${fmt(board.border)} mm border on the ${worst}.`;
  }
  return { left, right, bottom, top, min, status, message };
}

export function fitBoard(board: BoardSettings, env: Envelope, border = TWO_INCH_BORDER_MM): BoardSettings {
  return {
    ...board,
    width: env.maxX - env.minX + 2 * border,
    height: env.maxY - env.minY + 2 * border,
    centerX: (env.minX + env.maxX) / 2,
    centerY: (env.minY + env.maxY) / 2,
    border,
    origin: 'fitted',
  };
}

function fmt(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}
