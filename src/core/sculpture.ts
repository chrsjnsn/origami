/**
 * Canonical sculpture data (imported from origami1829-final-vision.blend) and the
 * geometry rules shared by every part of the app.
 *
 * Units are millimeters. Board coordinates: X right, Y up, Z outward toward the viewer.
 * The mounting plane is z = 0.
 */

export type Vec3 = [number, number, number];

export interface CanonicalPiece {
  id: string;
  col: number;
  row: number;
  vertices: Vec3[];
  faces: number[][];
  corner: number;
  right: number;
  up: number;
  apex: number;
  diagonalMidpoint: Vec3;
  baseCentroid: Vec3;
}

export interface CanonicalSculpture {
  format: string;
  version: number;
  source: { file: string; sha256: string; blender: string; note: string };
  units: 'mm';
  coordinateSystem: string;
  grid: { cols: number; rows: number; spacingMm: number; extentMm: [number, number] };
  innerScale: number;
  innerRule: string;
  topology: { verticesPerShell: number; facesPerShell: number; description: string };
  presentation: { outerThicknessMm: number; innerThicknessMm: number; boardThicknessMm: number; borderMm: number };
  board: { widthMm: number; heightMm: number; thicknessMm: number; center: [number, number]; topZMm: number };
  evaluatedEnvelopeMm: { outer: [Vec3, Vec3]; inner: [Vec3, Vec3]; design: [Vec3, Vec3] };
  stats: {
    tipHeightMm: { min: number; max: number; median: number; mean: number };
    leanFromCentroidMm: { x: [number, number]; y: [number, number] };
  };
  pieces: CanonicalPiece[];
}

export const INNER_SCALE = 0.75;

/**
 * Immutable, index-addressed view of the imported sculpture.
 * Piece index = row * cols + col.
 *
 * Typed arrays cannot be frozen, so the rule is: nothing writes to a Sculpture's arrays.
 * Editable state always works on copies (see DesignState); tests verify the originals
 * are unchanged after every kind of edit.
 */
export class Sculpture {
  readonly data: CanonicalSculpture;
  readonly count: number;
  readonly cols: number;
  readonly rows: number;
  readonly spacing: number;
  readonly ids: readonly string[];
  /** Fixed base-grid anchors (base centroid), 3 per piece. Tips are anchor + offset. */
  readonly anchors: Float64Array;
  /** Original vertices in Blender vertex order, 4 x 3 per piece. */
  readonly originalVertices: Float64Array;
  /** Diagonal midpoint M = (right + up) / 2, 3 per piece. */
  readonly midpoints: Float64Array;
  /** Vertex role indices per piece: [corner, right, up, apex]. */
  readonly roles: Uint8Array;
  /** Faces per piece as stored in Blender (3 faces x 3 indices into the piece's 4 vertices). */
  readonly faces: Uint8Array;
  /** Imported tip offsets relative to anchors (the "Current sculpture" starting point). */
  readonly originalOffsets: Float64Array;
  /** Neutral tip offsets: above the base centroid at the imported median height. */
  readonly neutralOffsets: Float64Array;
  readonly medianHeight: number;

  constructor(data: CanonicalSculpture) {
    this.data = deepFreeze(data);
    const pieces = [...data.pieces].sort((a, b) => a.row - b.row || a.col - b.col);
    this.cols = data.grid.cols;
    this.rows = data.grid.rows;
    this.spacing = data.grid.spacingMm;
    this.count = pieces.length;
    if (this.count !== this.cols * this.rows) {
      throw new Error(`Expected ${this.cols * this.rows} pieces, found ${this.count}`);
    }
    this.ids = Object.freeze(pieces.map((p) => p.id));
    this.anchors = new Float64Array(this.count * 3);
    this.originalVertices = new Float64Array(this.count * 12);
    this.midpoints = new Float64Array(this.count * 3);
    this.roles = new Uint8Array(this.count * 4);
    this.faces = new Uint8Array(this.count * 9);
    this.originalOffsets = new Float64Array(this.count * 3);
    this.neutralOffsets = new Float64Array(this.count * 3);

    pieces.forEach((p, i) => {
      if (p.row * this.cols + p.col !== i) throw new Error(`Piece ${p.id} is out of grid order`);
      for (let v = 0; v < 4; v++) {
        for (let k = 0; k < 3; k++) this.originalVertices[i * 12 + v * 3 + k] = p.vertices[v][k];
      }
      this.roles.set([p.corner, p.right, p.up, p.apex], i * 4);
      p.faces.forEach((f, fi) => this.faces.set(f, i * 9 + fi * 3));
      for (let k = 0; k < 3; k++) {
        // Anchor: base centroid computed from the three fixed base vertices.
        this.anchors[i * 3 + k] = p.baseCentroid[k];
        this.midpoints[i * 3 + k] = (p.vertices[p.right][k] + p.vertices[p.up][k]) / 2;
        this.originalOffsets[i * 3 + k] = p.vertices[p.apex][k] - p.baseCentroid[k];
      }
    });

    const heights = pieces.map((p) => p.vertices[p.apex][2]).sort((a, b) => a - b);
    const mid = heights.length >> 1;
    this.medianHeight = heights.length % 2 ? heights[mid] : (heights[mid - 1] + heights[mid]) / 2;
    for (let i = 0; i < this.count; i++) {
      this.neutralOffsets[i * 3] = 0;
      this.neutralOffsets[i * 3 + 1] = 0;
      this.neutralOffsets[i * 3 + 2] = this.medianHeight - this.anchors[i * 3 + 2];
    }
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }

  /** Tip positions (3 per piece) for a set of offsets. */
  tipsFromOffsets(offsets: Float64Array, out: Float64Array = new Float64Array(this.count * 3)): Float64Array {
    for (let j = 0; j < this.count * 3; j++) out[j] = this.anchors[j] + offsets[j];
    return out;
  }

  /**
   * Outer and inner vertices (Blender vertex order) for the given tip positions.
   * Base vertices always come from the imported file; only the apex moves.
   * Inner vertices are always rebuilt with inner = M + 0.75 (V - M).
   */
  shellVertices(
    tips: Float64Array,
    outer: Float64Array = new Float64Array(this.count * 12),
    inner: Float64Array = new Float64Array(this.count * 12),
  ): { outer: Float64Array; inner: Float64Array } {
    const ov = this.originalVertices;
    for (let i = 0; i < this.count; i++) {
      const apex = this.roles[i * 4 + 3];
      const mx = this.midpoints[i * 3];
      const my = this.midpoints[i * 3 + 1];
      const mz = this.midpoints[i * 3 + 2];
      for (let v = 0; v < 4; v++) {
        const o = i * 12 + v * 3;
        let x: number, y: number, z: number;
        if (v === apex) {
          x = tips[i * 3];
          y = tips[i * 3 + 1];
          z = tips[i * 3 + 2];
        } else {
          x = ov[o];
          y = ov[o + 1];
          z = ov[o + 2];
        }
        outer[o] = x;
        outer[o + 1] = y;
        outer[o + 2] = z;
        inner[o] = innerCoord(mx, x);
        inner[o + 1] = innerCoord(my, y);
        inner[o + 2] = innerCoord(mz, z);
      }
    }
    return { outer, inner };
  }
}

/** One coordinate of the inner rule: M + 0.75 (V - M). */
export function innerCoord(m: number, v: number): number {
  return m + INNER_SCALE * (v - m);
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value);
  }
  return obj;
}
