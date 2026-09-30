import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Sculpture, type CanonicalSculpture } from '../src/core/sculpture';

const root = fileURLToPath(new URL('..', import.meta.url));

export function loadJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(root + rel, 'utf8')) as T;
}

let cached: Sculpture | null = null;
export function loadSculpture(): Sculpture {
  cached ??= new Sculpture(loadJson<CanonicalSculpture>('public/assets/sculpture.json'));
  return cached;
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Largest deviation of inner vertices from M + 0.75 (V - M) and of diagonal midpoints. */
export function innerRuleError(s: Sculpture, outer: Float64Array, inner: Float64Array) {
  let rule = 0;
  let midpoint = 0;
  let collinear = 0;
  for (let i = 0; i < s.count; i++) {
    const r = s.roles[i * 4 + 1], u = s.roles[i * 4 + 2];
    for (let v = 0; v < 4; v++) {
      for (let k = 0; k < 3; k++) {
        const m = s.midpoints[i * 3 + k];
        rule = Math.max(rule, Math.abs(m + 0.75 * (outer[i * 12 + v * 3 + k] - m) - inner[i * 12 + v * 3 + k]));
      }
    }
    for (let k = 0; k < 3; k++) {
      const mo = (outer[i * 12 + r * 3 + k] + outer[i * 12 + u * 3 + k]) / 2;
      const mi = (inner[i * 12 + r * 3 + k] + inner[i * 12 + u * 3 + k]) / 2;
      midpoint = Math.max(midpoint, Math.abs(mo - mi));
    }
    // Inner diagonal endpoints lie on the outer diagonal line.
    const R = [0, 1, 2].map((k) => outer[i * 12 + r * 3 + k]);
    const U = [0, 1, 2].map((k) => outer[i * 12 + u * 3 + k]);
    const d = [U[0] - R[0], U[1] - R[1], U[2] - R[2]];
    const dl = Math.hypot(d[0], d[1], d[2]);
    for (const idx of [r, u]) {
      const w = [0, 1, 2].map((k) => inner[i * 12 + idx * 3 + k] - R[k]);
      const c = [d[1] * w[2] - d[2] * w[1], d[2] * w[0] - d[0] * w[2], d[0] * w[1] - d[1] * w[0]];
      collinear = Math.max(collinear, Math.hypot(c[0], c[1], c[2]) / dl);
    }
  }
  return { rule, midpoint, collinear };
}

/** Largest change of any base vertex from the imported file (must be exactly 0). */
export function baseChange(s: Sculpture, outer: Float64Array): number {
  let m = 0;
  for (let i = 0; i < s.count; i++) {
    const apex = s.roles[i * 4 + 3];
    for (let v = 0; v < 4; v++) {
      if (v === apex) continue;
      for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(outer[i * 12 + v * 3 + k] - s.originalVertices[i * 12 + v * 3 + k]));
    }
  }
  return m;
}

export function hashArray(a: Float64Array): string {
  let h = 2166136261;
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * How often tips line up: the percentage of runs of `win` neighboring pieces whose value stays
 * within `tol` mm, for tip x along columns, tip y along rows, and tip height along rows and
 * columns. A wave-like pattern keeps all four low (the original: 1, 1, 2 and 7%).
 */
export function straightness(s: Sculpture, offsets: Float64Array, win = 5, tol = 3) {
  const { cols, rows } = s;
  const value = (i: number, k: number) => (k === 2 ? s.anchors[i * 3 + 2] + offsets[i * 3 + 2] : offsets[i * 3 + k]);
  const run = (k: number, alongRow: boolean) => {
    const lines = alongRow ? rows : cols, len = alongRow ? cols : rows;
    let straight = 0, total = 0;
    for (let a = 0; a < lines; a++) {
      for (let b = 0; b + win <= len; b++) {
        let lo = Infinity, hi = -Infinity;
        for (let t = 0; t < win; t++) {
          const v = value(alongRow ? a * cols + b + t : (b + t) * cols + a, k);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        total++;
        if (hi - lo < tol) straight++;
      }
    }
    return (100 * straight) / total;
  };
  return { xAlongColumns: run(0, false), yAlongRows: run(1, true), zAlongRows: run(2, true), zAlongColumns: run(2, false) };
}
