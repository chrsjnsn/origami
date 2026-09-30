import { describe, expect, it } from 'vitest';
import { borderReport, importedBoard, presentationEnvelope, TWO_INCH_BORDER_MM } from '../src/core/board';
import { deserializeDesign, poseTips } from '../src/core/design';
import { buildDesignGlb } from '../src/core/exportGeometry';
import { lookDesignFile } from '../src/core/exportLook';
import { readAccessor, readGlb } from '../src/core/glb';
import { isOriginal, ORIGINAL_COLORS, ORIGINAL_LOOK, PALETTES, sanitizeLook } from '../src/core/look';
import { validateShells } from '../src/core/validation';
import {
  LIMITS,
  makeSafe,
  rng,
  STYLE_DEFAULTS,
  STYLES,
  type StyleId,
  type Variation,
  VariationEngine,
} from '../src/core/variations';
import { inches, inchValue } from '../src/ui/units';
import { baseChange, innerRuleError, loadJson, loadSculpture, maxAbsDiff, straightness } from './helpers';

const sculpture = loadSculpture();
const engine = new VariationEngine(sculpture);
const EXACT = 1e-9; // mm
const PATTERN_STYLES = STYLES.filter((s) => s.id !== 'original').map((s) => s.id as Exclude<StyleId, 'original'>);

function shells(offsets: Float64Array) {
  const tips = sculpture.tipsFromOffsets(offsets);
  return { tips, ...sculpture.shellVertices(tips) };
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

  it('the original pose matches the imported tips exactly and rebuilds the saved inner shells', () => {
    const p = shells(sculpture.originalOffsets);
    expect(maxAbsDiff(p.outer, sculpture.originalVertices)).toBeLessThan(1e-12);
    const e = innerRuleError(sculpture, p.outer, p.inner);
    expect(e.rule).toBeLessThan(EXACT);
    expect(e.midpoint).toBeLessThan(EXACT);
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

  it('reproduces the Blender board size and border within the bevel tolerance', () => {
    const p = shells(sculpture.originalOffsets);
    const env = presentationEnvelope(sculpture, p.outer, p.inner);
    const blenderEnv = sculpture.data.evaluatedEnvelopeMm.outer;
    const diffs = [env.minX - blenderEnv[0][0], env.minY - blenderEnv[0][1], env.maxX - blenderEnv[1][0], env.maxY - blenderEnv[1][1]];
    for (const d of diffs) expect(Math.abs(d)).toBeLessThan(0.5);
    const report = borderReport(importedBoard(sculpture), env);
    expect(report.status).toBe('ok');
    expect(report.min).toBeGreaterThan(TWO_INCH_BORDER_MM - 0.5);
  });

  it('the imported sculpture passes the geometry check', () => {
    const p = shells(sculpture.originalOffsets);
    const r = validateShells(sculpture, p.outer, p.inner);
    expect(r.issues).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('the geometry check finds a crafted crossing between neighbors', () => {
    const tips = sculpture.tipsFromOffsets(sculpture.neutralOffsets);
    const a = sculpture.index(5, 5), b = sculpture.index(6, 5);
    tips[a * 3] = sculpture.anchors[b * 3];
    tips[a * 3 + 2] = 30;
    const { outer, inner } = sculpture.shellVertices(tips);
    expect(validateShells(sculpture, outer, inner).intersectingPairs).toContainEqual([a, b]);
  });
});

describe('pattern variations', () => {
  it('"Original" shows the imported sculpture exactly', () => {
    const off = engine.offsets({ ...ORIGINAL_LOOK.variation }, 123);
    expect(maxAbsDiff(off, sculpture.originalOffsets)).toBe(0);
  });

  it('is deterministic: the pose depends only on the settings and the moment', () => {
    for (const style of PATTERN_STYLES) {
      const v: Variation = { style, seed: 42, ...STYLE_DEFAULTS[style] };
      const a = engine.offsets(v, 17.25);
      const other = new VariationEngine(sculpture).offsets({ ...v }, 17.25);
      expect(maxAbsDiff(a, other)).toBe(0);
      // Shuffle (a new seed) gives a different pattern.
      expect(maxAbsDiff(a, engine.offsets({ ...v, seed: 43 }, 17.25))).toBeGreaterThan(5);
    }
  });

  it('the lowest intensity is half strength and still clearly patterned', () => {
    for (const style of PATTERN_STYLES) {
      const v: Variation = { style, seed: 3, ...STYLE_DEFAULTS[style] };
      const maxLean = (off: Float64Array) => Math.max(...Array.from({ length: sculpture.count }, (_, i) => Math.hypot(off[i * 3], off[i * 3 + 1])));
      const low = maxLean(engine.offsets({ ...v, intensity: 0 }, 9));
      const high = maxLean(engine.offsets({ ...v, intensity: 1 }, 9));
      expect(low).toBeGreaterThan(25);
      expect(low).toBeLessThan(high);
    }
  });

  it('strength 0 (the floor of the safety net) is the calm rest pose: tips centered at the rest height', () => {
    const off = engine.offsets({ style: 'drift', intensity: 1, scale: 0.5, flow: 0.5, seed: 3 }, 9, undefined, 0);
    for (let i = 0; i < sculpture.count; i++) {
      expect(Math.abs(off[i * 3])).toBeLessThan(1e-9);
      expect(Math.abs(off[i * 3 + 1])).toBeLessThan(1e-9);
      expect(sculpture.anchors[i * 3 + 2] + off[i * 3 + 2]).toBeCloseTo(LIMITS.restHeight, 9);
    }
  });

  it('keeps bases fixed, inner shells exact 75% copies, and never writes to the original', () => {
    const before = sculpture.originalVertices.slice();
    for (const style of PATTERN_STYLES) {
      const p = shells(engine.offsets({ style, seed: 7, intensity: 1, scale: 0.2, flow: 1 }, 31));
      expect(baseChange(sculpture, p.outer)).toBe(0);
      const e = innerRuleError(sculpture, p.outer, p.inner);
      expect(e.rule).toBeLessThan(EXACT);
      expect(e.midpoint).toBeLessThan(EXACT);
    }
    expect(maxAbsDiff(sculpture.originalVertices, before)).toBe(0);
  });

  it('every style is bold like the original: far-reaching leans next to calmer areas', () => {
    for (const style of PATTERN_STYLES) {
      for (const seed of [1, 2, 3]) {
        const off = engine.offsets({ style, seed, ...STYLE_DEFAULTS[style] }, 0);
        const lean = Array.from({ length: sculpture.count }, (_, i) => Math.hypot(off[i * 3], off[i * 3 + 1])).sort((x, y) => x - y);
        const z = Array.from({ length: sculpture.count }, (_, i) => sculpture.anchors[i * 3 + 2] + off[i * 3 + 2]);
        // The strongest tips lean far over (the original reaches about 69 mm) ...
        expect(lean[lean.length - 1]).toBeGreaterThan(40);
        // ... while a good share of the board stays calm, for contrast.
        expect(lean[Math.floor(lean.length * 0.2)]).toBeLessThan(22);
        // Heights use most of the original's range.
        expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(30);
      }
    }
  });

  it('shows waves along every row and column: tips do not line up in x, y or height', () => {
    const original = straightness(sculpture, sculpture.originalOffsets);
    expect(Math.max(...Object.values(original))).toBeLessThan(8);
    const r = rng(77);
    let sum = 0, count = 0, worst = 0;
    for (const style of PATTERN_STYLES) {
      for (let n = 0; n < 16; n++) {
        // Starting settings and random settings, including every slider extreme.
        const v: Variation =
          n < 4
            ? { style, seed: n + 1, ...STYLE_DEFAULTS[style] }
            : { style, seed: Math.floor(r() * 1e6), intensity: [0, 1, r()][n % 3], scale: [0, 1, r(), r()][n % 4], flow: [0, 1, r()][(n + 1) % 3] };
        const m = Object.values(straightness(sculpture, engine.offsets(v, r() * 600)));
        worst = Math.max(worst, ...m);
        sum += m.reduce((a, b) => a + b, 0) / m.length;
        count++;
      }
    }
    // On average about as few straight runs as the original, and never many more than its worst.
    expect(sum / count).toBeLessThan(3);
    expect(worst).toBeLessThan(12);
  });

  it('moves slowly and smoothly when animated', () => {
    for (const style of PATTERN_STYLES) {
      const v: Variation = { style, seed: 11, intensity: 1, scale: 0, flow: 1 };
      const a = engine.offsets(v, 50);
      const b = engine.offsets(v, 50 + 1 / 60);
      // Fastest tip movement between two frames at 60 fps, in mm per second.
      expect(maxAbsDiff(a, b) * 60).toBeLessThan(40);
    }
  });

  it('stays inside the geometry limits for every style at the strongest settings', () => {
    const b = engine.bounds;
    const off = new Float64Array(sculpture.count * 3);
    for (const style of PATTERN_STYLES) {
      for (const scale of [0, 1]) {
        for (const t of [0, 13.7]) {
          engine.offsets({ style, seed: 5, intensity: 1, scale, flow: 1 }, t, off);
          for (let i = 0; i < sculpture.count; i++) {
            const x = sculpture.anchors[i * 3] + off[i * 3], y = sculpture.anchors[i * 3 + 1] + off[i * 3 + 1];
            const z = sculpture.anchors[i * 3 + 2] + off[i * 3 + 2];
            expect(z).toBeGreaterThanOrEqual(LIMITS.minHeight);
            expect(z).toBeLessThanOrEqual(LIMITS.maxHeight);
            expect(Math.hypot(off[i * 3], off[i * 3 + 1])).toBeLessThanOrEqual(LIMITS.maxLean);
            expect(x).toBeGreaterThanOrEqual(b.minX);
            expect(x).toBeLessThanOrEqual(b.maxX);
            expect(y).toBeGreaterThanOrEqual(b.minY);
            expect(y).toBeLessThanOrEqual(b.maxY);
          }
        }
      }
    }
  });

  it('never produces a geometry issue or uses the 2-inch border (random sweep of 600 variations)', () => {
    const r = rng(20260929);
    const board = importedBoard(sculpture);
    const off = new Float64Array(sculpture.count * 3);
    let issues = 0, minBorder = Infinity;
    for (let n = 0; n < 600; n++) {
      const v: Variation = {
        style: PATTERN_STYLES[n % PATTERN_STYLES.length],
        // Half the cases at the extremes of every slider.
        intensity: r() < 0.5 ? 1 : r(),
        scale: r() < 0.3 ? Math.round(r()) : r(),
        flow: r() < 0.3 ? 1 : r(),
        seed: Math.floor(r() * 1e6),
      };
      const p = shells(engine.offsets(v, r() * 3600, off));
      issues += validateShells(sculpture, p.outer, p.inner).issues.length;
      const br = borderReport(board, presentationEnvelope(sculpture, p.outer, p.inner));
      minBorder = Math.min(minBorder, br.min);
    }
    expect(issues).toBe(0);
    expect(minBorder).toBeGreaterThan(TWO_INCH_BORDER_MM);
  }, 120000);

  it('the safety net leaves safe poses alone and tones unsafe ones down until they are clean', () => {
    const v: Variation = { style: 'crosscurrent', seed: 9, intensity: 1, scale: 0, flow: 1 };
    const out = new Float64Array(sculpture.count * 3);
    expect(makeSafe(engine, v, 4, out).strength).toBe(1);
    // Force an unsafe mapping by loosening the built-in limits.
    const saved = { ...LIMITS };
    Object.assign(LIMITS, { neighborLeanStep: 400, maxLean: 150, minHeight: 2, heightAmplitude: 60 });
    try {
      const res = makeSafe(engine, v, 4, out);
      expect(res.strength).toBeLessThan(1);
      const p = shells(out);
      expect(validateShells(sculpture, p.outer, p.inner).issues).toEqual([]);
    } finally {
      Object.assign(LIMITS, saved);
    }
  });
});

describe('looks', () => {
  it('reads untrusted saved data safely, with defaults for anything missing or invalid', () => {
    expect(sanitizeLook(null)).toEqual(ORIGINAL_LOOK);
    const l = sanitizeLook({
      variation: { style: 'spiral', intensity: 7, scale: -1, flow: 'x', seed: -12.7 },
      colors: { outer: '#ABCDEF', inner: 'red', board: '#12345' },
      time: -5,
    });
    expect(l.variation).toEqual({ style: 'spiral', intensity: 1, scale: 0, flow: ORIGINAL_LOOK.variation.flow, seed: 12 });
    expect(l.colors).toEqual({ outer: '#abcdef', inner: ORIGINAL_COLORS.inner, board: ORIGINAL_COLORS.board });
    expect(l.time).toBe(0);
    expect(sanitizeLook({ variation: { style: 'nope' } }).variation.style).toBe('original');
    expect(isOriginal(ORIGINAL_LOOK)).toBe(true);
  });

  it('palettes are valid colors and start with the artwork’s own', () => {
    for (const part of ['outer', 'inner', 'board'] as const) {
      for (const sw of PALETTES[part]) expect(sw.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(PALETTES[part][0].hex).toBe(ORIGINAL_COLORS[part]);
    }
  });

  it('formats imperial measurements to the nearest 1/16 inch', () => {
    expect(inchValue(sculpture.data.board.widthMm)).toBe('62 1/16');
    expect(inchValue(sculpture.data.board.heightMm)).toBe('40 15/16');
    expect(inches(50.8, 4)).toBe('2 in');
    expect(inches(6, 8)).toBe('1/4 in');
    expect(inches(sculpture.data.stats.tipHeightMm.max)).toBe('2 13/16 in');
  });
});

describe('exports', () => {
  const look = sanitizeLook({ variation: { style: 'drift', seed: 21, intensity: 0.9, scale: 0.5, flow: 0.35 }, colors: { outer: '#1d2a47', inner: '#ffc400', board: '#b08a5f' }, time: 42 });

  it('the Blender design file rebuilds exactly the pose shown, with the chosen colors', () => {
    const off = engine.offsets(look.variation, look.time);
    const file = JSON.parse(JSON.stringify(lookDesignFile(sculpture, look, off, 'Drift test')));
    expect(file.colors).toEqual(look.colors);
    expect(file.look).toEqual(look);
    expect(file.validation.passed).toBe(true);
    expect(file.validation.warnings).toBe(0);
    const loaded = deserializeDesign(sculpture, file);
    expect(loaded.poseMismatchMm).toBe(0);
    expect(maxAbsDiff(poseTips(sculpture, loaded.snapshot), sculpture.tipsFromOffsets(off))).toBe(0);
    expect(loaded.snapshot.board).toEqual(importedBoard(sculpture));
  });

  it('rejects design files for a different sculpture', () => {
    const file = lookDesignFile(sculpture, ORIGINAL_LOOK, sculpture.originalOffsets, 'x');
    file.pieceIds[3] = 'C99-R99';
    expect(() => deserializeDesign(sculpture, file)).toThrow();
  });

  it('the GLB matches the pose, keeps topology, maps to Blender coordinates and carries the colors', () => {
    const p = shells(engine.offsets(look.variation, look.time));
    const glb = readGlb(buildDesignGlb(sculpture, p.outer, p.inner, importedBoard(sculpture), { includePresentation: true, designName: 't', colors: look.colors }));
    expect(glb.json.materials.map((m: any) => m.name)).toEqual(['Outer paper #1d2a47', 'Inner paper #ffc400', 'Board #b08a5f']);
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
          const bx = pos[v * 3] * 1000, by = -pos[v * 3 + 2] * 1000, bz = pos[v * 3 + 1] * 1000;
          err = Math.max(err, Math.abs(bx - src[i * 12 + v * 3]), Math.abs(by - src[i * 12 + v * 3 + 1]), Math.abs(bz - src[i * 12 + v * 3 + 2]));
        }
      }
    }
    expect(err).toBeLessThan(2e-4); // float32 meters
  });
});
