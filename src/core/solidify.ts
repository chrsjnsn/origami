/**
 * Presentation stock thickness, replicating Blender's Simple Solidify modifier
 * (no even offset, rim on): every vertex moves along its angle-weighted vertex normal.
 *
 * Outer shells: offset +1, 0.45 mm (stock extends outward from the design surface).
 * Inner shells: offset -1, 0.25 mm (stock extends inward, so the blue base sits above the
 * black base without moving either design triangle). The inner base corners move straight up by
 * the full thickness: on low pyramids their vertex normals point almost sideways (the base and
 * side normals nearly cancel), which left the blue base level with or below the black base, and
 * the two surfaces flickered through each other.
 *
 * This is presentation only. It never feeds back into the editable tip data.
 */

export interface ShellSpec {
  thickness: number;
  /** +1 = new surface on the normal side (outer), -1 = original moves inward (inner). */
  offset: 1 | -1;
}

/** Triangles per thickened shell: 3 faces x 2 sides + 3 rim quads x 2. */
export const TRIS_PER_SHELL = 12;
export const FLOATS_PER_SHELL = TRIS_PER_SHELL * 9;

const tmp = {
  fn: new Float64Array(9),
  vn: new Float64Array(12),
  pa: new Float64Array(12),
  pb: new Float64Array(12),
};

function faceNormal(v: ArrayLike<number>, o: number, a: number, b: number, c: number, out: Float64Array, fo: number) {
  const ax = v[o + a * 3], ay = v[o + a * 3 + 1], az = v[o + a * 3 + 2];
  const ux = v[o + b * 3] - ax, uy = v[o + b * 3 + 1] - ay, uz = v[o + b * 3 + 2] - az;
  const wx = v[o + c * 3] - ax, wy = v[o + c * 3 + 1] - ay, wz = v[o + c * 3 + 2] - az;
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[fo] = nx / l;
  out[fo + 1] = ny / l;
  out[fo + 2] = nz / l;
}

function cornerAngle(v: ArrayLike<number>, o: number, at: number, p: number, q: number): number {
  const ax = v[o + at * 3], ay = v[o + at * 3 + 1], az = v[o + at * 3 + 2];
  const ux = v[o + p * 3] - ax, uy = v[o + p * 3 + 1] - ay, uz = v[o + p * 3 + 2] - az;
  const wx = v[o + q * 3] - ax, wy = v[o + q * 3 + 1] - ay, wz = v[o + q * 3 + 2] - az;
  const d = (ux * wx + uy * wy + uz * wz) / ((Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz)) || 1);
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/**
 * Write the thickened triangles of one shell.
 * @param verts   shell vertices (4 x 3) starting at `vo`
 * @param faces   3 faces x 3 vertex indices starting at `fo` (stored winding, outward normals)
 * @param pos     output positions (FLOATS_PER_SHELL floats at `po`)
 * @param nor     output flat normals (same layout)
 */
export function writeThickShell(
  verts: ArrayLike<number>,
  vo: number,
  faces: ArrayLike<number>,
  fo: number,
  spec: ShellSpec,
  pos: Float32Array | Float64Array,
  nor: Float32Array | Float64Array | null,
  po: number,
): void {
  const { fn, vn, pa, pb } = tmp;
  vn.fill(0);
  for (let f = 0; f < 3; f++) {
    const a = faces[fo + f * 3], b = faces[fo + f * 3 + 1], c = faces[fo + f * 3 + 2];
    faceNormal(verts, vo, a, b, c, fn, f * 3);
    const corners: [number, number, number][] = [[a, b, c], [b, c, a], [c, a, b]];
    for (const [at, p, q] of corners) {
      const w = cornerAngle(verts, vo, at, p, q);
      vn[at * 3] += w * fn[f * 3];
      vn[at * 3 + 1] += w * fn[f * 3 + 1];
      vn[at * 3 + 2] += w * fn[f * 3 + 2];
    }
  }
  if (spec.offset === -1) {
    // The base is the face pointing most downward; its corners take the base normal.
    let base = 0;
    for (let f = 1; f < 3; f++) if (fn[f * 3 + 2] < fn[base * 3 + 2]) base = f;
    for (let c = 0; c < 3; c++) {
      const v = faces[fo + base * 3 + c];
      vn[v * 3] = fn[base * 3];
      vn[v * 3 + 1] = fn[base * 3 + 1];
      vn[v * 3 + 2] = fn[base * 3 + 2];
    }
  }
  const t = spec.thickness;
  const ofsA = spec.offset === 1 ? 0 : -t;
  const ofsB = spec.offset === 1 ? t : 0;
  for (let v = 0; v < 4; v++) {
    const l = Math.hypot(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) {
      const n = vn[v * 3 + k] / l;
      const base = verts[vo + v * 3 + k];
      pa[v * 3 + k] = base + ofsA * n;
      pb[v * 3 + k] = base + ofsB * n;
    }
  }

  let w = po;
  const emit = (p: Float64Array, i: number, j: number, k: number, nx: number, ny: number, nz: number) => {
    for (const idx of [i, j, k]) {
      pos[w] = p[idx * 3];
      pos[w + 1] = p[idx * 3 + 1];
      pos[w + 2] = p[idx * 3 + 2];
      if (nor) {
        nor[w] = nx;
        nor[w + 1] = ny;
        nor[w + 2] = nz;
      }
      w += 3;
    }
  };
  const emitMixed = (
    p0: Float64Array, i0: number, p1: Float64Array, i1: number, p2: Float64Array, i2: number,
    dx: number, dy: number, dz: number,
  ) => {
    // Triangle from mixed surfaces with an outward direction hint; winding fixed to match it.
    const ax = p0[i0 * 3], ay = p0[i0 * 3 + 1], az = p0[i0 * 3 + 2];
    const bx = p1[i1 * 3], by = p1[i1 * 3 + 1], bz = p1[i1 * 3 + 2];
    const cx = p2[i2 * 3], cy = p2[i2 * 3 + 1], cz = p2[i2 * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * dx + ny * dy + nz * dz < 0;
    const pts = flip ? [[cx, cy, cz], [bx, by, bz], [ax, ay, az]] : [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    const s = flip ? -1 : 1;
    for (const q of pts) {
      pos[w] = q[0];
      pos[w + 1] = q[1];
      pos[w + 2] = q[2];
      if (nor) {
        nor[w] = s * nx;
        nor[w + 1] = s * ny;
        nor[w + 2] = s * nz;
      }
      w += 3;
    }
  };

  const edgeUse = new Map<number, number>();
  for (let f = 0; f < 3; f++) {
    const a = faces[fo + f * 3], b = faces[fo + f * 3 + 1], c = faces[fo + f * 3 + 2];
    const nx = fn[f * 3], ny = fn[f * 3 + 1], nz = fn[f * 3 + 2];
    // Surface B lies on the +n side of the slab; surface A on the -n side (reversed winding).
    emit(pb, a, b, c, nx, ny, nz);
    emit(pa, a, c, b, -nx, -ny, -nz);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(p, q) * 4 + Math.max(p, q);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  // Rims on boundary edges (the open triangle right-up-apex).
  for (let f = 0; f < 3; f++) {
    const a = faces[fo + f * 3], b = faces[fo + f * 3 + 1], c = faces[fo + f * 3 + 2];
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]]) {
      if (edgeUse.get(Math.min(p, q) * 4 + Math.max(p, q)) !== 1) continue;
      // Outward direction: perpendicular to the edge, away from the face's third vertex.
      const ex = verts[vo + q * 3] - verts[vo + p * 3];
      const ey = verts[vo + q * 3 + 1] - verts[vo + p * 3 + 1];
      const ez = verts[vo + q * 3 + 2] - verts[vo + p * 3 + 2];
      const nx = fn[f * 3], ny = fn[f * 3 + 1], nz = fn[f * 3 + 2];
      let ox = ey * nz - ez * ny, oy = ez * nx - ex * nz, oz = ex * ny - ey * nx;
      const rx = verts[vo + r * 3] - verts[vo + p * 3];
      const ry = verts[vo + r * 3 + 1] - verts[vo + p * 3 + 1];
      const rz = verts[vo + r * 3 + 2] - verts[vo + p * 3 + 2];
      if (ox * rx + oy * ry + oz * rz > 0) { ox = -ox; oy = -oy; oz = -oz; }
      emitMixed(pa, p, pa, q, pb, q, ox, oy, oz);
      emitMixed(pa, p, pb, q, pb, p, ox, oy, oz);
    }
  }
  if (w - po !== FLOATS_PER_SHELL) throw new Error(`Unexpected shell size ${w - po}`);
}
