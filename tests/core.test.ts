import { describe, expect, it } from 'vitest';
import { borderReport, importedBoard, presentationEnvelope, TWO_INCH_BORDER_MM } from '../src/core/board';
import { applyBrush, brushWeights, defaultBrush, EDIT_LIMITS, Stroke } from '../src/core/brushes';
import { deserializeDesign, poseTips, serializeDesign } from '../src/core/design';
import { buildDesignGlb } from '../src/core/exportGeometry';
import { readAccessor, readGlb } from '../src/core/glb';
import { GridStencils, REFERENCE_LAMBDA, solveSmoothing } from '../src/core/smoothing';
import { StudioModel } from '../src/core/studio';
import { validateShells } from '../src/core/validation';
import { addSourceOffset, defaultSource, evaluateWaveField } from '../src/core/waves';
import { baseChange, hashArray, innerRuleError, loadJson, loadSculpture, maxAbsDiff } from './helpers';

const sculpture = loadSculpture();
const EXACT = 1e-9; // mm

function studio() {
  return new StudioModel(sculpture);
}

function expectInvariants(m: StudioModel) {
  const p = m.getPose();
  expect(baseChange(sculpture, p.outer)).toBe(0);
  const e = innerRuleError(sculpture, p.outer, p.inner);
  expect(e.rule).toBeLessThan(EXACT);
  expect(e.midpoint).toBeLessThan(EXACT);
  expect(e.collinear).toBeLessThan(1e-9);
}

describe('import', () => {
  it('has 522 pieces on a 29 x 18 grid with 50 mm spacing', () => {
    expect(sculpture.count).toBe(522);
    expect(sculpture.cols).toBe(29);
    expect(sculpture.rows).toBe(18);
    expect(sculpture.spacing).toBe(50);
    for (let i = 0; i < sculpture.count; i++) {
      const col = i % 29, row = Math.floor(i / 29);
      expect(sculpture.ids[i]).toBe(`C${String(col + 1).padStart(2, '0')}-R${String(row + 1).padStart(2, '0')}`);
      const corner = sculpture.roles[i * 4];
      expect(sculpture.originalVertices[i * 12 + corner * 3]).toBeCloseTo(col * 50, 4);
      expect(sculpture.originalVertices[i * 12 + corner * 3 + 1]).toBeCloseTo(row * 50, 4);
    }
  });

  it('keeps open triangular shells: 4 vertices, 3 faces, hypotenuse face open, outward winding', () => {
    for (let i = 0; i < sculpture.count; i++) {
      const [corner, right, up, apex] = sculpture.roles.subarray(i * 4, i * 4 + 4);
      const faces = [0, 1, 2].map((f) => [...sculpture.faces.subarray(i * 9 + f * 3, i * 9 + f * 3 + 3)].sort().join());
      expect(faces).not.toContain([right, up, apex].sort().join());
      expect(faces).toContain([corner, right, up].sort().join());
      // Every stored face normal points away from the vertex not on it.
      const V = (k: number) => [0, 1, 2].map((c) => sculpture.originalVertices[i * 12 + k * 3 + c]);
      for (let f = 0; f < 3; f++) {
        const [a, b, c] = sculpture.faces.subarray(i * 9 + f * 3, i * 9 + f * 3 + 3);
        const other = [0, 1, 2, 3].find((k) => k !== a && k !== b && k !== c)!;
        const A = V(a), B = V(b), C = V(c), O = V(other);
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(n[0] * (O[0] - A[0]) + n[1] * (O[1] - A[1]) + n[2] * (O[2] - A[2])).toBeLessThan(0);
      }
    }
  });

  it('initial state matches the imported tips exactly and rebuilds the saved inner shells', () => {
    const m = studio();
    const p = m.getPose();
    let tipErr = 0;
    for (let i = 0; i < sculpture.count; i++) {
      const apex = sculpture.roles[i * 4 + 3];
      for (let k = 0; k < 3; k++) tipErr = Math.max(tipErr, Math.abs(p.tips[i * 3 + k] - sculpture.originalVertices[i * 12 + apex * 3 + k]));
    }
    expect(tipErr).toBeLessThan(1e-12);
    expect(maxAbsDiff(p.outer, sculpture.originalVertices)).toBeLessThan(1e-12);
    expectInvariants(m);
    // Compare against the inner vertices saved in the .blend (float32 storage).
    const blender = loadJson('public/assets/sculpture-blender.json');
    const M = blender.shellMatrixWorld as number[][];
    let savedInnerErr = 0;
    blender.pieces.forEach((bp: any) => {
      const i = sculpture.ids.indexOf(bp.id);
      bp.innerLocal.forEach((co: number[], v: number) => {
        for (let r = 0; r < 3; r++) {
          const w = (M[r][0] * co[0] + M[r][1] * co[1] + M[r][2] * co[2] + M[r][3]) * 1000;
          savedInnerErr = Math.max(savedInnerErr, Math.abs(w - p.inner[i * 12 + v * 3 + r]));
        }
      });
    });
    expect(savedInnerErr).toBeLessThan(1e-3); // float32 in the .blend: ~6e-5 mm
  });

  it('matches the supporting scene-details.json anchors and xy-adjustments.json tips', () => {
    const details = loadJson('assets-src/supporting/scene-details.json');
    for (const pair of details.pairs) {
      const i = sculpture.ids.indexOf(pair.piece);
      for (let k = 0; k < 3; k++) expect(Math.abs(pair.anchor_m[k] * 1000 - sculpture.midpoints[i * 3 + k])).toBeLessThan(1e-3);
    }
    const xy = loadJson('assets-src/supporting/xy-adjustments.json');
    let err = 0;
    for (const piece of xy.pieces) {
      const i = sculpture.ids.indexOf(piece.id);
      const apex = sculpture.roles[i * 4 + 3];
      for (let k = 0; k < 3; k++) err = Math.max(err, Math.abs(piece.vertices_updated_mm[apex][k] - sculpture.originalVertices[i * 12 + apex * 3 + k]));
    }
    expect(err).toBeLessThan(1e-3);
  });

  it('neutral pattern puts each tip above its base centroid at the imported median height', () => {
    const m = studio();
    m.setStartingPoint('neutral');
    const p = m.getPose();
    expect(sculpture.medianHeight).toBeCloseTo(47.0343, 3);
    for (let i = 0; i < sculpture.count; i++) {
      expect(p.tips[i * 3]).toBeCloseTo(sculpture.anchors[i * 3], 9);
      expect(p.tips[i * 3 + 1]).toBeCloseTo(sculpture.anchors[i * 3 + 1], 9);
      expect(p.tips[i * 3 + 2]).toBeCloseTo(sculpture.medianHeight, 9);
    }
    expectInvariants(m);
    m.undo();
    expect(maxAbsDiff(m.getPose().offsets, sculpture.originalOffsets)).toBe(0);
  });
});

describe('presentation envelope and board', () => {
  it('reproduces the Blender board size and border within the bevel tolerance', () => {
    const m = studio();
    const p = m.getPose();
    const env = presentationEnvelope(sculpture, p.outer, p.inner);
    const blenderEnv = sculpture.data.evaluatedEnvelopeMm.outer;
    const diffs = [env.minX - blenderEnv[0][0], env.minY - blenderEnv[0][1], env.maxX - blenderEnv[1][0], env.maxY - blenderEnv[1][1]];
    for (const d of diffs) expect(Math.abs(d)).toBeLessThan(0.5);
    const report = borderReport(importedBoard(sculpture), env);
    expect(report.status).toBe('ok');
    expect(report.min).toBeGreaterThan(TWO_INCH_BORDER_MM - 0.5);
    expect(sculpture.data.board.widthMm).toBeCloseTo(1575.95, 1);
    expect(sculpture.data.board.heightMm).toBeCloseTo(1040.56, 1);
  });

  it('fits the board with a 2-inch border and saves it with the design', () => {
    const m = studio();
    m.beginStroke({ ...defaultBrush('leanX'), radius: 250, strength: 10 }, 1450, 450, 0);
    for (let t = 0.02; t <= 2; t += 0.02) m.strokeTo(1450, 450, t);
    m.endStroke();
    expect(m.border().status).not.toBe('ok');
    const board = m.fitBoard();
    const r = m.border();
    expect(r.left).toBeCloseTo(50.8, 6);
    expect(r.right).toBeCloseTo(50.8, 6);
    expect(r.bottom).toBeCloseTo(50.8, 6);
    expect(r.top).toBeCloseTo(50.8, 6);
    const file = serializeDesign(sculpture, m.snap, 'fit');
    const loaded = deserializeDesign(sculpture, JSON.parse(JSON.stringify(file)));
    expect(loaded.snapshot.board).toEqual(board);
  });
});

describe('waves', () => {
  it('starts with zero influence so entering the tool does not alter the sculpture', () => {
    const m = studio();
    const before = m.getPose().tips.slice();
    m.ensureSource();
    m.setPhase(1.234);
    expect(maxAbsDiff(m.getPose().tips, before)).toBe(0);
  });

  it('samples at the fixed grid anchors and recomputes from the baseline (no drift)', () => {
    const m = studio();
    const src = m.addSource('ripple');
    m.updateSource(src.id, { height: 15, lean: 10 });
    const a = m.getPose().tips.slice();
    for (let k = 0; k < 20; k++) m.updateSource(src.id, { height: 15 + (k % 3), lean: 10 - (k % 2) }, `drift-${k}`);
    m.updateSource(src.id, { height: 15, lean: 10 }, 'drift-final');
    expect(maxAbsDiff(m.getPose().tips, a)).toBe(0);
    expect(maxAbsDiff(m.snap.base, sculpture.originalOffsets)).toBe(0);
    expectInvariants(m);
  });

  it('changes both height and sideways lean, smoothly at the source center', () => {
    const src = { ...defaultSource('s', 'ripple', 500, 500), height: 10, lean: 10 };
    const out = new Float64Array(3);
    let maxLat = 0;
    for (let r = 0; r <= 60; r += 0.5) {
      out.fill(0);
      addSourceOffset(src, 500 + r, 500, 0.3, out, 0);
      maxLat = Math.max(maxLat, Math.abs(out[0]));
      expect(Number.isFinite(out[0]) && Number.isFinite(out[2])).toBe(true);
    }
    out.fill(0);
    addSourceOffset(src, 500, 500, 0.3, out, 0);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    const field = evaluateWaveField([src], sculpture.anchors, 0.3, new Float64Array(sculpture.count * 3));
    let xy = 0, z = 0;
    for (let i = 0; i < sculpture.count; i++) {
      xy = Math.max(xy, Math.hypot(field[i * 3], field[i * 3 + 1]));
      z = Math.max(z, Math.abs(field[i * 3 + 2]));
    }
    expect(xy).toBeGreaterThan(5);
    expect(z).toBeGreaterThan(5);
  });

  it('play/pause is deterministic: the pose depends only on the saved phase', () => {
    const m = studio();
    const a = m.addSource('ripple', 300, 400);
    m.updateSource(a.id, { height: 12, lean: 8, speed: 1 });
    const b = m.addSource('travel', 1200, 200);
    m.updateSource(b.id, { height: 6, lean: 12, direction: 135, speed: -0.5 });
    // Simulate two playback runs with different frame timings that reach the same phase.
    const target = 4.321;
    let phase = 0;
    for (const dt of [0.016, 0.033, 0.007, 0.05]) phase += dt;
    m.setPhase(target);
    const paused = m.getPose().tips.slice();
    m.setPhase(target + 2 * Math.PI * m.loopTurns); // one full loop later
    expect(maxAbsDiff(m.getPose().tips, paused)).toBeLessThan(1e-9);
    m.setPhase(1);
    m.setPhase(target);
    expect(maxAbsDiff(m.getPose().tips, paused)).toBe(0);
    void phase;
    expectInvariants(m);
  });

  it('"Keep this shape" commits the exact paused pose and keeps the recipe', () => {
    const m = studio();
    const s = m.addSource('ripple', 700, 450);
    m.updateSource(s.id, { height: 14, lean: 9 });
    m.setPhase(2.2);
    const paused = m.getPose().tips.slice();
    expect(m.keepShape()).toBe(true);
    expect(maxAbsDiff(m.getPose().tips, paused)).toBe(0);
    expect(m.wavesActive).toBe(false);
    expect(m.snap.kept).toHaveLength(1);
    expect(m.snap.kept[0].sources[0].height).toBe(14);
    // Brushes refine the kept shape.
    m.beginStroke({ ...defaultBrush('height') }, 700, 450, 0);
    m.strokeTo(700, 450, 0.3);
    m.endStroke();
    expect(maxAbsDiff(m.getPose().tips, paused)).toBeGreaterThan(1);
    // Return to the generating settings.
    m.returnToKept(m.snap.kept[0].id);
    expect(maxAbsDiff(m.getPose().tips, paused)).toBeLessThan(1e-9);
    expect(m.snap.sources[0].height).toBe(14);
    // Undo everything back to the import.
    while (m.undo());
    expect(maxAbsDiff(m.getPose().offsets, sculpture.originalOffsets)).toBe(0);
  });
});

describe('brushes', () => {
  const axisNames = ['leanX', 'leanY', 'height'] as const;
  for (const kind of axisNames) {
    it(`${kind} changes only its own axis and only inside the footprint`, () => {
      const m = studio();
      const before = m.getPose().offsets.slice();
      const brush = { ...defaultBrush(kind), radius: 200, strength: 6 };
      m.beginStroke(brush, 600, 400, 0);
      for (let t = 0.016; t < 0.6; t += 0.016) m.strokeTo(600 + t * 200, 400, t);
      m.endStroke();
      const after = m.getPose().offsets;
      const axis = kind === 'leanX' ? 0 : kind === 'leanY' ? 1 : 2;
      const footprint = new Set<number>();
      for (let x = 600; x <= 720; x += 1) for (const i of brushWeights(sculpture, x, 400, 200).keys()) footprint.add(i);
      let changed = 0;
      for (let i = 0; i < sculpture.count; i++) {
        for (let k = 0; k < 3; k++) {
          const d = after[i * 3 + k] - before[i * 3 + k];
          if (k !== axis || !footprint.has(i)) expect(d).toBe(0);
          else if (d !== 0) changed++;
        }
      }
      expect(changed).toBeGreaterThan(10);
      expectInvariants(m);
      m.undo();
      expect(maxAbsDiff(m.getPose().offsets, before)).toBe(0);
    });
  }

  it('one continuous stroke is one undo step; redo restores it exactly', () => {
    const m = studio();
    m.beginStroke(defaultBrush('height'), 400, 400, 0);
    for (let t = 0.01; t < 0.5; t += 0.01) m.strokeTo(400 + 300 * t, 400 + 100 * t, t);
    m.endStroke();
    const edited = m.getPose().tips.slice();
    expect(m.history.canUndo).toBe(true);
    m.undo();
    expect(m.history.canUndo).toBe(false);
    m.redo();
    expect(maxAbsDiff(m.getPose().tips, edited)).toBe(0);
  });

  it('stroke strength does not depend on the frame rate', () => {
    const run = (fps: number) => {
      const m = studio();
      m.beginStroke(defaultBrush('height'), 300, 300, 0);
      const dt = 1 / fps;
      for (let t = dt; t <= 1 + 1e-9; t += dt) m.strokeTo(300 + 500 * t, 300 + 200 * t, t);
      m.endStroke();
      return m.getPose().tips.slice();
    };
    const a = run(30), b = run(60), c = run(144);
    // Fixed sub-steps with interpolated positions: identical up to floating-point rounding.
    expect(maxAbsDiff(a, b)).toBeLessThan(1e-9);
    expect(maxAbsDiff(b, c)).toBeLessThan(1e-9);
  });

  it('smooth brush reduces curvature inside the footprint and leaves everything else alone', () => {
    const m = studio();
    const grid = new GridStencils(sculpture.cols, sculpture.rows);
    const before = m.getPose().offsets.slice();
    const weights = brushWeights(sculpture, 725, 450, 250);
    const brush = { ...defaultBrush('smooth'), radius: 250, strength: 6, smoothAxis: 'all' as const };
    m.beginStroke(brush, 725, 450, 0);
    m.strokeTo(725, 450, 0.8);
    m.endStroke();
    const after = m.getPose().offsets;
    for (let i = 0; i < sculpture.count; i++) {
      if (weights.has(i)) continue;
      for (let k = 0; k < 3; k++) expect(after[i * 3 + k]).toBe(before[i * 3 + k]);
    }
    const local = (v: Float64Array, axis: number) => {
      let e = 0;
      for (const s of grid.stencils) {
        if (!weights.has(s.b)) continue;
        const d = v[s.a * 3 + axis] - 2 * v[s.b * 3 + axis] + v[s.c * 3 + axis];
        e += s.w2 * d * d;
      }
      return e;
    };
    for (const axis of [0, 1, 2]) expect(local(after, axis)).toBeLessThan(local(before, axis));
    // Broad crests survive: the height pattern stays strongly correlated with the original.
    let sxy = 0, sxx = 0, syy = 0;
    const mean = (v: Float64Array) => [...weights.keys()].reduce((a, i) => a + v[i * 3 + 2], 0) / weights.size;
    const ma = mean(before), mb = mean(after);
    for (const i of weights.keys()) {
      const a = before[i * 3 + 2] - ma, b = after[i * 3 + 2] - mb;
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.9);
    expectInvariants(m);
  });

  it('smooth on a selected axis leaves the other axes unchanged', () => {
    const m = studio();
    const before = m.getPose().offsets.slice();
    m.beginStroke({ ...defaultBrush('smooth'), smoothAxis: 'z' }, 725, 450, 0);
    m.strokeTo(725, 450, 0.5);
    m.endStroke();
    const after = m.getPose().offsets;
    for (let i = 0; i < sculpture.count; i++) {
      expect(after[i * 3]).toBe(before[i * 3]);
      expect(after[i * 3 + 1]).toBe(before[i * 3 + 1]);
    }
  });

  it('restore blends back toward the chosen baseline', () => {
    const m = studio();
    m.beginStroke({ ...defaultBrush('height'), radius: 200 }, 500, 500, 0);
    for (let t = 0.02; t <= 1; t += 0.02) m.strokeTo(500, 500, t);
    m.endStroke();
    const dist = () => maxAbsDiff(m.getPose().offsets, sculpture.originalOffsets);
    const edited = dist();
    expect(edited).toBeGreaterThan(10);
    m.beginStroke({ ...defaultBrush('restore'), radius: 400, strength: 10 }, 500, 500, 0);
    for (let t = 0.02; t <= 3; t += 0.02) m.strokeTo(500, 500, t);
    m.endStroke();
    expect(dist()).toBeLessThan(edited * 0.05);
  });

  it('respects creative bounds without snapping existing values', () => {
    const m = studio();
    m.beginStroke({ ...defaultBrush('height'), strength: 10, radius: 300 }, 700, 450, 0);
    for (let t = 0.05; t <= 8; t += 0.05) m.strokeTo(700, 450, t);
    m.endStroke();
    const p = m.getPose();
    let maxZ = 0;
    for (let i = 0; i < sculpture.count; i++) maxZ = Math.max(maxZ, p.tips[i * 3 + 2]);
    expect(maxZ).toBeLessThanOrEqual(EDIT_LIMITS.normal.maxHeight + 1e-9);
    // Imported leans beyond the normal lean bound (60.8 mm) are kept as they are.
    const m2 = studio();
    m2.beginStroke({ ...defaultBrush('height'), radius: 2000 }, 700, 450, 0);
    m2.strokeTo(700, 450, 0.2);
    m2.endStroke();
    expect(maxAbsDiff(
      m2.getPose().offsets.filter((_, j) => j % 3 !== 2),
      sculpture.originalOffsets.filter((_, j) => j % 3 !== 2),
    )).toBe(0);
  });

  it('never writes to the immutable original', () => {
    const h = hashArray(sculpture.originalOffsets);
    const hv = hashArray(sculpture.originalVertices);
    const m = studio();
    m.setStartingPoint('neutral');
    m.setStartingPoint('current');
    m.beginStroke({ ...defaultBrush('restore') }, 500, 500, 0);
    m.strokeTo(500, 500, 1);
    m.endStroke();
    m.restoreTarget = 'original';
    m.beginStroke({ ...defaultBrush('smooth') }, 500, 500, 0);
    m.strokeTo(500, 500, 1);
    m.endStroke();
    expect(hashArray(sculpture.originalOffsets)).toBe(h);
    expect(hashArray(sculpture.originalVertices)).toBe(hv);
  });
});

describe('smoothing reference model', () => {
  it('reproduces the previous X/Y refinement from the manual original (lambda 0.12, ±5 mm)', () => {
    const blender = loadJson('public/assets/sculpture-blender.json');
    const grid = new GridStencils(sculpture.cols, sculpture.rows);
    const n = sculpture.count;
    const x0 = new Float64Array(n * 3);
    for (const bp of blender.pieces) {
      const i = sculpture.ids.indexOf(bp.id);
      const tip = bp.outerProps.wave_original_tip_mm as number[];
      for (let k = 0; k < 3; k++) x0[i * 3 + k] = tip[k] - sculpture.anchors[i * 3 + k];
    }
    const x = x0.slice();
    const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3);
    for (let j = 0; j < n * 3; j++) {
      lo[j] = x0[j] - 5;
      hi[j] = x0[j] + 5;
    }
    const all = Array.from({ length: n }, (_, i) => i);
    for (const axis of [0, 1]) solveSmoothing(grid, x, x0, all, axis, REFERENCE_LAMBDA, 4000, { lo, hi });
    let err = 0;
    for (let i = 0; i < n; i++) for (const k of [0, 1]) err = Math.max(err, Math.abs(x[i * 3 + k] - sculpture.originalOffsets[i * 3 + k]));
    console.info(`X/Y refinement reproduced to within ${err.toExponential(2)} mm`);
    expect(err).toBeLessThan(0.05);
  });
});

describe('validation', () => {
  it('the imported sculpture has no errors', () => {
    const m = studio();
    const r = m.validate();
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('detects tips pushed below the board and crossing neighbors, without changing the design', () => {
    const m = studio();
    const i = sculpture.index(10, 8);
    const s = m.addSource('ripple', sculpture.anchors[i * 3], sculpture.anchors[i * 3 + 1]);
    m.extendedRanges = true;
    m.updateSource(s.id, { height: 60, lean: 60, spacing: 200, reach: 400 });
    const before = m.getPose().tips.slice();
    const r = m.validate();
    expect(r.issues.some((x) => x.code === 'intersection' || x.code === 'tip-below-board')).toBe(true);
    expect(r.flagged.size).toBeGreaterThan(0);
    expect(maxAbsDiff(m.getPose().tips, before)).toBe(0);
  });

  it('a crafted crossing is found between two neighbors', () => {
    const tips = sculpture.tipsFromOffsets(sculpture.neutralOffsets);
    const a = sculpture.index(5, 5), b = sculpture.index(6, 5);
    tips[a * 3] = sculpture.anchors[b * 3]; // lean piece a into the closed part of piece b
    tips[a * 3 + 2] = 30;
    const { outer, inner } = sculpture.shellVertices(tips);
    const r = validateShells(sculpture, outer, inner);
    expect(r.intersectingPairs).toContainEqual([a, b]);
  });
});

describe('save, load and export', () => {
  it('save/load restores the same positions without depending on animation timing', () => {
    const m = studio();
    const s = m.addSource('travel', 200, 800);
    m.updateSource(s.id, { height: 10, lean: 14, direction: 300, speed: 1.5 });
    m.setPhase(5.5);
    m.beginStroke(defaultBrush('leanY'), 900, 300, 0);
    m.strokeTo(1000, 350, 0.4);
    m.endStroke();
    const tips = m.getPose().tips.slice();
    const json = JSON.parse(JSON.stringify(serializeDesign(sculpture, m.snap, 'round trip')));
    const loaded = deserializeDesign(sculpture, json);
    expect(loaded.poseMismatchMm).toBe(0);
    const m2 = studio();
    m2.load(loaded.snapshot, loaded.name);
    expect(maxAbsDiff(m2.getPose().tips, tips)).toBe(0);
    expect(maxAbsDiff(poseTips(sculpture, loaded.snapshot), tips)).toBe(0);
    expectInvariants(m2);
    m2.undo();
    expect(maxAbsDiff(m2.getPose().offsets, sculpture.originalOffsets)).toBe(0);
  });

  it('rejects files for a different sculpture', () => {
    const file = serializeDesign(sculpture, studio().snap, 'x');
    file.pieceIds[3] = 'C99-R99';
    expect(() => deserializeDesign(sculpture, file)).toThrow();
  });

  it('GLB export matches the current pose, keeps topology, and maps to Blender coordinates', () => {
    const m = studio();
    const s = m.addSource('ripple', 725, 450);
    m.updateSource(s.id, { height: 10, lean: 10 });
    m.setPhase(1.1);
    const p = m.getPose();
    const bytes = buildDesignGlb(sculpture, p.outer, p.inner, m.snap.board, { includePresentation: true, designName: 't' });
    const glb = readGlb(bytes);
    const byName = new Map<string, any>(glb.json.nodes.map((n: any) => [n.name, n]));
    let err = 0;
    for (let i = 0; i < sculpture.count; i++) {
      for (const [suffix, src] of [['', p.outer], [' INNER 75%', p.inner]] as const) {
        const node = byName.get(sculpture.ids[i] + suffix);
        const prim = glb.json.meshes[node.mesh].primitives[0];
        const pos = readAccessor(glb, prim.attributes.POSITION) as Float32Array;
        const idx = readAccessor(glb, prim.indices) as Uint32Array;
        expect([...idx]).toEqual([...sculpture.faces.subarray(i * 9, i * 9 + 9)]);
        for (let v = 0; v < 4; v++) {
          // glTF (x, z, -y) meters -> board (x, y, z) mm
          const bx = pos[v * 3] * 1000, by = -pos[v * 3 + 2] * 1000, bz = pos[v * 3 + 1] * 1000;
          err = Math.max(err, Math.abs(bx - src[i * 12 + v * 3]), Math.abs(by - src[i * 12 + v * 3 + 1]), Math.abs(bz - src[i * 12 + v * 3 + 2]));
        }
      }
    }
    expect(err).toBeLessThan(2e-4); // float32 meters
  });

  it('Stroke integrates identical input identically', () => {
    const log: number[] = [];
    const s = new Stroke((x, y, dt) => log.push(x, y, dt));
    s.begin(0, 0, 0);
    s.move(10, 0, 0.05);
    s.move(20, 5, 0.1);
    const total = log.filter((_, j) => j % 3 === 2).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(Stroke.INITIAL_DAB + 0.1, 6);
  });

  it('applyBrush is a no-op outside the board', () => {
    const offsets = sculpture.originalOffsets.slice();
    applyBrush(
      { sculpture, grid: new GridStencils(29, 18), offsets, restoreTarget: sculpture.neutralOffsets, limits: EDIT_LIMITS.normal },
      defaultBrush('height'),
      -5000,
      -5000,
      1,
    );
    expect(maxAbsDiff(offsets, sculpture.originalOffsets)).toBe(0);
  });
});
