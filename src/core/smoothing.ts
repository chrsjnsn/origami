/**
 * Bending-energy smoothing on the fixed 29 x 18 grid.
 *
 * Reference (previous refinement): for each coordinate minimize
 *   sum_i (x_i - x0_i)^2 + lambda * sum_stencils (w * (x_a - 2 x_b + x_c))^2
 * with second differences along rows and columns (w = 1) and both diagonals (w = 0.35,
 * applied before squaring), lambda = 0.12.
 *
 * The brush solves the same problem locally: only pieces inside the brush are unknowns,
 * everything else is held fixed as a boundary condition, so nothing outside the brush moves.
 */

export const REFERENCE_LAMBDA = 0.12;
export const DIAGONAL_WEIGHT = 0.35;

export interface Stencil {
  a: number;
  b: number;
  c: number;
  /** Squared weight (w^2). */
  w2: number;
}

export class GridStencils {
  readonly stencils: Stencil[] = [];
  /** For each piece, indices into `stencils` that contain it. */
  readonly byPiece: number[][];
  /** Diagonal of K = sum w^2 a a^T. */
  readonly kDiag: Float64Array;

  constructor(readonly cols: number, readonly rows: number) {
    const idx = (c: number, r: number) => r * cols + c;
    const add = (a: number, b: number, c: number, w: number) => this.stencils.push({ a, b, c, w2: w * w });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c > 0 && c < cols - 1) add(idx(c - 1, r), idx(c, r), idx(c + 1, r), 1);
        if (r > 0 && r < rows - 1) add(idx(c, r - 1), idx(c, r), idx(c, r + 1), 1);
        if (c > 0 && c < cols - 1 && r > 0 && r < rows - 1) {
          add(idx(c - 1, r - 1), idx(c, r), idx(c + 1, r + 1), DIAGONAL_WEIGHT);
          add(idx(c - 1, r + 1), idx(c, r), idx(c + 1, r - 1), DIAGONAL_WEIGHT);
        }
      }
    }
    const n = cols * rows;
    this.byPiece = Array.from({ length: n }, () => []);
    this.kDiag = new Float64Array(n);
    this.stencils.forEach((s, si) => {
      this.byPiece[s.a].push(si);
      this.byPiece[s.b].push(si);
      this.byPiece[s.c].push(si);
      this.kDiag[s.a] += s.w2;
      this.kDiag[s.b] += 4 * s.w2;
      this.kDiag[s.c] += s.w2;
    });
  }

  /** Bending energy of one axis of an interleaved xyz array. */
  energy(values: Float64Array, axis: number): number {
    let e = 0;
    for (const s of this.stencils) {
      const d = values[s.a * 3 + axis] - 2 * values[s.b * 3 + axis] + values[s.c * 3 + axis];
      e += s.w2 * d * d;
    }
    return e;
  }

  /** RMS second difference (unweighted rows + columns), a simple curvature measure. */
  rmsCurvature(values: Float64Array, axis: number): number {
    let e = 0;
    let n = 0;
    for (const s of this.stencils) {
      if (s.w2 !== 1) continue;
      const d = values[s.a * 3 + axis] - 2 * values[s.b * 3 + axis] + values[s.c * 3 + axis];
      e += d * d;
      n++;
    }
    return Math.sqrt(e / n);
  }
}

function coefficient(s: Stencil, i: number): number {
  return i === s.b ? -2 : 1;
}

/**
 * Solve (I + lambda K) x = x0 on the unknowns `free` (others fixed at their current value)
 * with Gauss-Seidel. `x` holds interleaved xyz values and is updated in place for `axis`.
 * `x0` is the fidelity target for the same layout. Optional per-piece bounds [lo, hi].
 */
export function solveSmoothing(
  grid: GridStencils,
  x: Float64Array,
  x0: Float64Array,
  free: readonly number[],
  axis: number,
  lambda: number,
  iterations: number,
  bounds?: { lo: Float64Array; hi: Float64Array },
): void {
  for (let it = 0; it < iterations; it++) {
    for (const i of free) {
      let kx = 0;
      for (const si of grid.byPiece[i]) {
        const s = grid.stencils[si];
        const d = x[s.a * 3 + axis] - 2 * x[s.b * 3 + axis] + x[s.c * 3 + axis];
        kx += s.w2 * coefficient(s, i) * d;
      }
      const kii = grid.kDiag[i];
      const xi = x[i * 3 + axis];
      let next = (x0[i * 3 + axis] - lambda * (kx - kii * xi)) / (1 + lambda * kii);
      if (bounds) next = Math.min(bounds.hi[i * 3 + axis], Math.max(bounds.lo[i * 3 + axis], next));
      x[i * 3 + axis] = next;
    }
  }
}

/**
 * One smoothing dab: pieces with weight w_i > 0 move a fraction `amount * w_i` of the way
 * toward the locally smoothed solution. Pieces with w_i = 0 are untouched.
 */
export function smoothDab(
  grid: GridStencils,
  offsets: Float64Array,
  weights: ReadonlyMap<number, number>,
  axes: readonly number[],
  lambda: number,
  amount: number,
  scratch: Float64Array = new Float64Array(offsets.length),
): void {
  if (weights.size === 0 || amount <= 0) return;
  const free = [...weights.keys()];
  scratch.set(offsets);
  for (const axis of axes) {
    solveSmoothing(grid, scratch, offsets, free, axis, lambda, 16);
  }
  for (const [i, w] of weights) {
    const f = Math.min(1, amount * w);
    for (const axis of axes) {
      const j = i * 3 + axis;
      offsets[j] += f * (scratch[j] - offsets[j]);
    }
  }
}
