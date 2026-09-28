/**
 * Geometric honesty checks on the design surfaces (not the presentation thickness).
 *
 * - valid (finite) coordinates
 * - base vertices unchanged, inner shells exactly M + 0.75 (V - M)
 * - positive tip height; very low tips are warned about
 * - nondegenerate side faces (area and minimum angle)
 * - strict crossings between neighboring shells' faces (outer and inner, both pieces).
 *   Touching at shared grid corners and coplanar base contacts are not crossings.
 *
 * Problems are reported and highlighted. Nothing here modifies the design.
 */

import type { Sculpture } from './sculpture';
import { INNER_SCALE } from './sculpture';

export type Severity = 'error' | 'warning';

export interface Issue {
  code: 'nonfinite' | 'base-moved' | 'inner-rule' | 'tip-below-board' | 'low-tip' | 'degenerate-face' | 'sliver-face' | 'intersection';
  severity: Severity;
  pieces: number[];
  message: string;
}

export interface ValidationResult {
  issues: Issue[];
  /** Worst severity per flagged piece. */
  flagged: Map<number, Severity>;
  pairsTested: number;
  intersectingPairs: [number, number][];
  complete: boolean;
  ms: number;
}

export const VALIDATION = {
  lowTipWarningMm: 6,
  minFaceAreaMm2: 2,
  sliverAngleDeg: 4,
  planeEps: 1e-6,
  baryEps: 1e-7,
  neighborCells: 3,
};

export interface ValidateOptions {
  /** Only check these pieces (and their neighbors for intersections). Omit for a complete check. */
  subset?: Iterable<number>;
}

export function validateShells(
  sculpture: Sculpture,
  outer: Float64Array,
  inner: Float64Array,
  options: ValidateOptions = {},
): ValidationResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const n = sculpture.count;
  const issues: Issue[] = [];
  const flagged = new Map<number, Severity>();
  const flag = (i: number, s: Severity) => {
    if (flagged.get(i) !== 'error') flagged.set(i, s);
  };
  const subset = options.subset ? [...new Set(options.subset)] : null;
  const pieces = subset ?? Array.from({ length: n }, (_, i) => i);

  const nonfinite: number[] = [];
  const baseMoved: number[] = [];
  const innerBad: number[] = [];
  const below: number[] = [];
  const low: number[] = [];
  const degenerate: number[] = [];
  const sliver: number[] = [];

  for (const i of pieces) {
    const o = i * 12;
    let finite = true;
    for (let k = 0; k < 12; k++) if (!Number.isFinite(outer[o + k]) || !Number.isFinite(inner[o + k])) finite = false;
    if (!finite) {
      nonfinite.push(i);
      continue;
    }
    const apex = sculpture.roles[i * 4 + 3];
    for (let v = 0; v < 4; v++) {
      if (v === apex) continue;
      for (let k = 0; k < 3; k++) {
        if (outer[o + v * 3 + k] !== sculpture.originalVertices[o + v * 3 + k]) baseMoved.push(i);
      }
    }
    let innerErr = 0;
    for (let v = 0; v < 4; v++) {
      for (let k = 0; k < 3; k++) {
        const m = sculpture.midpoints[i * 3 + k];
        innerErr = Math.max(innerErr, Math.abs(m + INNER_SCALE * (outer[o + v * 3 + k] - m) - inner[o + v * 3 + k]));
      }
    }
    if (innerErr > 1e-9) innerBad.push(i);
    const tz = outer[o + apex * 3 + 2];
    if (tz <= 0) below.push(i);
    else if (tz < VALIDATION.lowTipWarningMm) low.push(i);
    // Side faces: the two faces that contain the apex.
    let worstArea = Infinity;
    let worstAngle = Infinity;
    for (let f = 0; f < 3; f++) {
      const a = sculpture.faces[i * 9 + f * 3], b = sculpture.faces[i * 9 + f * 3 + 1], c = sculpture.faces[i * 9 + f * 3 + 2];
      if (a !== apex && b !== apex && c !== apex) continue;
      const { area, minAngle } = triangleShape(outer, o, a, b, c);
      worstArea = Math.min(worstArea, area);
      worstAngle = Math.min(worstAngle, minAngle);
    }
    if (tz > 0) {
      if (worstArea < VALIDATION.minFaceAreaMm2) degenerate.push(i);
      else if (worstAngle < (VALIDATION.sliverAngleDeg * Math.PI) / 180) sliver.push(i);
    }
  }

  const report = (list: number[], code: Issue['code'], severity: Severity, message: (k: number) => string) => {
    const unique = [...new Set(list)];
    if (!unique.length) return;
    unique.forEach((i) => flag(i, severity));
    issues.push({ code, severity, pieces: unique, message: message(unique.length) });
  };
  const s = (k: number) => (k === 1 ? '1 piece' : `${k} pieces`);
  report(nonfinite, 'nonfinite', 'error', (k) => `${s(k)} ${k === 1 ? 'has' : 'have'} invalid coordinates.`);
  report(baseMoved, 'base-moved', 'error', (k) => `${s(k)}: base vertices differ from the imported mounting grid.`);
  report(innerBad, 'inner-rule', 'error', (k) => `${s(k)}: inner shell is not the exact 75% copy.`);
  report(below, 'tip-below-board', 'error', (k) => `${s(k)}: tip is at or below the board. Raise the height.`);
  report(low, 'low-tip', 'warning', (k) => `${s(k)}: tip is under ${VALIDATION.lowTipWarningMm} mm, which would be nearly flat paper.`);
  report(degenerate, 'degenerate-face', 'error', (k) => `${s(k)}: a side face has almost no area (collapsed fold).`);
  report(sliver, 'sliver-face', 'warning', (k) => `${s(k)}: a side face is extremely thin (under ${VALIDATION.sliverAngleDeg}°).`);

  // Intersections between neighboring shells.
  const { pairs, tested } = findIntersections(sculpture, outer, inner, subset);
  if (pairs.length) {
    const involved = new Set<number>();
    for (const [a, b] of pairs) {
      involved.add(a);
      involved.add(b);
    }
    involved.forEach((i) => flag(i, 'error'));
    const first = pairs.slice(0, 3).map(([a, b]) => `${sculpture.ids[a]} / ${sculpture.ids[b]}`).join(', ');
    issues.push({
      code: 'intersection',
      severity: 'error',
      pieces: [...involved],
      message: `${pairs.length === 1 ? '1 pair' : `${pairs.length} pairs`} of neighboring pieces pass through each other (${first}${pairs.length > 3 ? ', …' : ''}).`,
    });
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { issues, flagged, pairsTested: tested, intersectingPairs: pairs, complete: !subset, ms: t1 - t0 };
}

function triangleShape(v: Float64Array, o: number, a: number, b: number, c: number) {
  const P = (i: number) => [v[o + i * 3], v[o + i * 3 + 1], v[o + i * 3 + 2]];
  const A = P(a), B = P(b), C = P(c);
  const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const bc = [C[0] - B[0], C[1] - B[1], C[2] - B[2]];
  const cx = ab[1] * ac[2] - ab[2] * ac[1], cy = ab[2] * ac[0] - ab[0] * ac[2], cz = ab[0] * ac[1] - ab[1] * ac[0];
  const area = 0.5 * Math.hypot(cx, cy, cz);
  const la = Math.hypot(...bc), lb = Math.hypot(...ac), lc = Math.hypot(...ab);
  const angle = (x: number, y: number, z: number) => Math.acos(Math.max(-1, Math.min(1, (y * y + z * z - x * x) / (2 * y * z || 1))));
  return { area, minAngle: Math.min(angle(la, lb, lc), angle(lb, la, lc), angle(lc, la, lb)) };
}

/** Axis-aligned bounds of each piece's outer shell (the inner shell lies inside its hull). */
function pieceBounds(outer: Float64Array, n: number): Float64Array {
  const b = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let v = 0; v < 4; v++) {
      const x = outer[i * 12 + v * 3], y = outer[i * 12 + v * 3 + 1], z = outer[i * 12 + v * 3 + 2];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    b.set([x0, y0, z0, x1, y1, z1], i * 6);
  }
  return b;
}

export function findIntersections(
  sculpture: Sculpture,
  outer: Float64Array,
  inner: Float64Array,
  subset: number[] | null,
): { pairs: [number, number][]; tested: number } {
  const n = sculpture.count;
  const bounds = pieceBounds(outer, n);
  const reach = VALIDATION.neighborCells;
  const pairs: [number, number][] = [];
  const seen = new Set<number>();
  let tested = 0;
  const sources = subset ?? Array.from({ length: n }, (_, i) => i);
  const tris = new Float64Array(6 * 9 * 2);
  for (const i of sources) {
    const ci = i % sculpture.cols, ri = Math.floor(i / sculpture.cols);
    for (let r = Math.max(0, ri - reach); r <= Math.min(sculpture.rows - 1, ri + reach); r++) {
      for (let c = Math.max(0, ci - reach); c <= Math.min(sculpture.cols - 1, ci + reach); c++) {
        const j = r * sculpture.cols + c;
        if (j === i) continue;
        const a = Math.min(i, j), b = Math.max(i, j);
        const key = a * n + b;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!boundsOverlap(bounds, a, b)) continue;
        tested++;
        loadTriangles(sculpture, outer, inner, a, tris, 0);
        loadTriangles(sculpture, outer, inner, b, tris, 54);
        if (shellsCross(tris)) pairs.push([a, b]);
      }
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { pairs, tested };
}

function boundsOverlap(b: Float64Array, i: number, j: number): boolean {
  return (
    b[i * 6] <= b[j * 6 + 3] && b[j * 6] <= b[i * 6 + 3] &&
    b[i * 6 + 1] <= b[j * 6 + 4] && b[j * 6 + 1] <= b[i * 6 + 4] &&
    b[i * 6 + 2] <= b[j * 6 + 5] && b[j * 6 + 2] <= b[i * 6 + 5]
  );
}

/** 6 triangles (3 outer + 3 inner) of piece i, 9 floats each. */
function loadTriangles(sculpture: Sculpture, outer: Float64Array, inner: Float64Array, i: number, out: Float64Array, o: number) {
  let w = o;
  for (const src of [outer, inner]) {
    for (let f = 0; f < 3; f++) {
      for (let k = 0; k < 3; k++) {
        const v = sculpture.faces[i * 9 + f * 3 + k];
        out[w++] = src[i * 12 + v * 3];
        out[w++] = src[i * 12 + v * 3 + 1];
        out[w++] = src[i * 12 + v * 3 + 2];
      }
    }
  }
}

function shellsCross(tris: Float64Array): boolean {
  for (let a = 0; a < 6; a++) {
    for (let b = 6; b < 12; b++) {
      if (trianglesCross(tris, a * 9, tris, b * 9)) return true;
    }
  }
  return false;
}

/** True if two triangles properly cross (an edge of one passes through the interior of the other). */
export function trianglesCross(A: ArrayLike<number>, ao: number, B: ArrayLike<number>, bo: number): boolean {
  return edgesPierce(A, ao, B, bo) || edgesPierce(B, bo, A, ao);
}

function edgesPierce(E: ArrayLike<number>, eo: number, T: ArrayLike<number>, to: number): boolean {
  const ax = T[to], ay = T[to + 1], az = T[to + 2];
  const ux = T[to + 3] - ax, uy = T[to + 4] - ay, uz = T[to + 5] - az;
  const vx = T[to + 6] - ax, vy = T[to + 7] - ay, vz = T[to + 8] - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-12) return false;
  nx /= nl; ny /= nl; nz /= nl;
  const eps = VALIDATION.planeEps;
  const dist = (k: number) => (E[eo + k * 3] - ax) * nx + (E[eo + k * 3 + 1] - ay) * ny + (E[eo + k * 3 + 2] - az) * nz;
  const d = [dist(0), dist(1), dist(2)];
  if (Math.abs(d[0]) <= eps && Math.abs(d[1]) <= eps && Math.abs(d[2]) <= eps) return false; // coplanar contact
  const uu = ux * ux + uy * uy + uz * uz, uv = ux * vx + uy * vy + uz * vz, vv = vx * vx + vy * vy + vz * vz;
  const den = uu * vv - uv * uv;
  for (let e = 0; e < 3; e++) {
    const p = e, q = (e + 1) % 3;
    const dp = d[p], dq = d[q];
    if (Math.abs(dp) <= eps || Math.abs(dq) <= eps) continue; // endpoint on the plane: contact, not a crossing
    if ((dp > 0) === (dq > 0)) continue;
    const t = dp / (dp - dq);
    const px = E[eo + p * 3] + t * (E[eo + q * 3] - E[eo + p * 3]) - ax;
    const py = E[eo + p * 3 + 1] + t * (E[eo + q * 3 + 1] - E[eo + p * 3 + 1]) - ay;
    const pz = E[eo + p * 3 + 2] + t * (E[eo + q * 3 + 2] - E[eo + p * 3 + 2]) - az;
    const wu = px * ux + py * uy + pz * uz, wv = px * vx + py * vy + pz * vz;
    const s = (vv * wu - uv * wv) / den;
    const r = (uu * wv - uv * wu) / den;
    const be = VALIDATION.baryEps;
    if (s > be && r > be && s + r < 1 - be) return true;
  }
  return false;
}
