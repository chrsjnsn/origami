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
