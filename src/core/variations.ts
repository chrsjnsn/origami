/**
 * Pattern variations: a style plus three sliders (intensity, scale, flow) and a seed produce a
 * complete pose for all 522 pyramids, with no manual editing.
 *
 * Every style is a small set of wave components evaluated at the fixed base-grid anchors, the
 * same model the original sculpture follows: along each wave, height follows sin(s) and the
 * sideways lean follows cos(s) in the wave's direction, so crests lean as they rise and fall.
 * On top of the waves, three slow fields give the patterns the character of the original:
 *
 * - contrast: broad areas of strong motion next to calmer areas,
 * - bend: a two-scale domain warp, so wave fronts curve instead of running straight,
 * - twist: the lean direction turns gradually across the board.
 *
 * The raw pattern is then measured and scaled so its strongest area reaches the geometry limits
 * (see LIMITS) and no further. That keeps every variation bold while making it impossible for
 * pyramids to be too short, fall toward the board, lean into their neighbors, or reach into the
 * 2-inch border of the original board. `makeSafe` is a final safety net that checks the shells
 * and, if needed, tones the variation down; it is not expected to change anything.
 */

import { validateShells } from './validation';
import type { Sculpture } from './sculpture';

export type StyleId = 'original' | 'ripple' | 'drift' | 'dunes' | 'crosscurrent' | 'bloom' | 'spiral';

export interface Variation {
  style: StyleId;
  /** 0 = flat, 1 = strongest safe pattern. */
  intensity: number;
  /** 0 = fine (short waves), 1 = broad. */
  scale: number;
  /** 0 = gently curving fronts, 1 = strongly swirling fronts. */
  flow: number;
  /** Shuffle: picks new positions, angles and timing for the style. */
  seed: number;
}

export const STYLES: readonly { id: StyleId; name: string; description: string }[] = [
  { id: 'original', name: 'Original', description: 'The sculpture as it was made.' },
  { id: 'drift', name: 'Drift', description: 'Bending diagonal bands that lean far over, like the original.' },
  { id: 'ripple', name: 'Ripple', description: 'Rings spreading from a point, like a stone dropped in water.' },
  { id: 'dunes', name: 'Dunes', description: 'Meandering crests with a gentle rise and a steep fall.' },
  { id: 'crosscurrent', name: 'Crosscurrent', description: 'Two currents meeting at an angle, weaving together in patches.' },
  { id: 'bloom', name: 'Bloom', description: 'Flowers of rings that burst from calm space.' },
  { id: 'spiral', name: 'Spiral', description: 'Arms curling around a center.' },
];

export const DEFAULT_VARIATION: Variation = { style: 'original', intensity: 0.9, scale: 0.5, flow: 0.4, seed: 1 };

/** Starting values when a style is first chosen. */
export const STYLE_DEFAULTS: Record<Exclude<StyleId, 'original'>, Pick<Variation, 'intensity' | 'scale' | 'flow'>> = {
  drift: { intensity: 0.95, scale: 0.55, flow: 0.45 },
  ripple: { intensity: 0.95, scale: 0.55, flow: 0.3 },
  dunes: { intensity: 0.95, scale: 0.6, flow: 0.55 },
  crosscurrent: { intensity: 0.95, scale: 0.6, flow: 0.4 },
  bloom: { intensity: 1, scale: 0.6, flow: 0.3 },
  spiral: { intensity: 0.95, scale: 0.6, flow: 0.25 },
};

/**
 * Geometry limits (mm). Heights stay within the character of the original (27–71 mm tips);
 * leans reach as far as the original's (up to about 69 mm along the diagonal) while neighboring
 * tips can never converge far enough to touch; all tips stay inside the board's 2-inch border.
 */
export const LIMITS = {
  /** Resting tip height of the variations (close to the original median, 47 mm). */
  restHeight: 46,
  minHeight: 22,
  maxHeight: 76,
  /** Height change of the strongest area at full intensity. */
  heightAmplitude: 26,
  /** Lean of the strongest area at full intensity. */
  maxLean: 66,
  /**
   * Largest lean difference between adjacent tips (per 50 mm of grid distance). The original
   * reaches 37.6 mm; much larger differences let neighboring tips converge until they touch.
   */
  neighborLeanStep: 38,
  /**
   * Calm areas lean slightly toward the upper right (closing the open side, so they read dark,
   * like the quiet areas of the original) and sit a little lower, which makes the active areas
   * stand out.
   */
  calmLean: 16,
  calmDrop: 6,
  /** Shortest and longest wave spacing. */
  minSpacing: 240,
  maxSpacing: 820,
  /** Tips keep at least this clearance to the board's 2-inch border line (paper thickness). */
  borderClearance: 1.5,
};

const TAU = Math.PI * 2;
/** One crest passes a point about every 24 seconds at speed 1: slow, ambient motion. */
const BASE_OMEGA = TAU / 24;

interface Component {
  kind: 'ripple' | 'travel' | 'spiral';
  x: number;
  y: number;
  /** Travel direction (radians) for traveling waves. */
  angle: number;
  /** Wavenumber relative to the base 2π / spacing. */
  k: number;
  weight: number;
  /** Falloff radius in spacings (Infinity = whole board). */
  reach: number;
  /** Phase speed relative to BASE_OMEGA; negative runs inward/backward. */
  speed: number;
  phase: number;
  /** Spiral arms. */
  arms: number;
  /** Crest asymmetry (0 = sine, up to about 0.6 = dune profile). */
  sharp: number;
}

/** A slowly drifting plane wave used by the contrast, bend and twist fields. */
interface Field {
  d: [number, number];
  /** Wavelength (mm) or, for bend fields, wavelength in spacings. */
  length: number;
  phase: number;
  /** Drift speed relative to BASE_OMEGA. */
  speed: number;
}

interface Recipe {
  components: Component[];
  /** Normalize by local coverage instead of total weight (separate blooms). */
  localNormalize: boolean;
  /** Calmest level of the contrast field (1 = no contrast). */
  contrastMin: number;
  contrast: [Field, Field];
  /** Extra bend for styles that would otherwise look straight. */
  bendBoost: number;
  bend: [Field, Field, Field, Field];
  bendAngles: [number, number];
  twist: Field;
}

/** Deterministic small PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function comp(p: Partial<Component>): Component {
  return { kind: 'travel', x: 0, y: 0, angle: 0, k: 1, weight: 1, reach: Infinity, speed: 1, phase: 0, arms: 0, sharp: 0, ...p };
}

/** Builds the wave components for a style and seed on a board of size W x H (anchors 0..W, 0..H). */
function recipe(style: Exclude<StyleId, 'original'>, seed: number, W: number, H: number): Recipe {
  const idx = STYLES.findIndex((s) => s.id === style);
  const r = rng(Math.imul(seed + 1, 2654435761) ^ (idx * 40503));
  const range = (a: number, b: number) => a + (b - a) * r();
  const sign = () => (r() < 0.5 ? -1 : 1);
  const cx = W / 2, cy = H / 2;
  const deg = Math.PI / 180;
  const components: Component[] = [];
  let localNormalize = false;
  let contrastMin = 0.3;
  let bendBoost = 1;

  switch (style) {
    case 'drift': {
      // Travel close to the (1, 1) diagonal, like the original's bands. Leaning along that
      // diagonal is what opens each pyramid's open side toward the viewer (the inside color
      // shows) or closes it; leaning across it would barely change the colors.
      const base = (range(20, 70) + (r() < 0.5 ? 180 : 0)) * deg;
      components.push(comp({ angle: base, phase: range(0, TAU), speed: 1 }));
      components.push(comp({ angle: base + sign() * range(15, 35) * deg, k: range(0.6, 0.75), weight: 0.6, phase: range(0, TAU), speed: 0.7 }));
      contrastMin = 0.3;
      break;
    }
    case 'ripple': {
      const x = cx + range(-0.32, 0.32) * W, y = cy + range(-0.3, 0.3) * H;
      components.push(comp({ kind: 'ripple', x, y, phase: range(0, TAU), speed: 1 }));
      const x2 = x < cx ? range(0.7, 1) * W : range(0, 0.3) * W;
      const y2 = y < cy ? range(0.65, 1) * H : range(0, 0.35) * H;
      components.push(comp({ kind: 'ripple', x: x2, y: y2, k: range(1.1, 1.3), weight: 0.4, phase: range(0, TAU), speed: 0.8 }));
      contrastMin = 0.4;
      break;
    }
    case 'dunes': {
      const base = (90 + sign() * range(0, 25)) * deg;
      components.push(comp({ angle: base, phase: range(0, TAU), speed: 0.8, sharp: range(0.35, 0.5) }));
      // A longer swell along the diagonal makes the crests merge and split like real dunes
      // (along the diagonal its lean also shows as color, not only as height) ...
      const swell = (45 + range(-12, 12) + (r() < 0.5 ? 180 : 0)) * deg;
      components.push(comp({ angle: swell, k: range(0.45, 0.6), weight: 0.6, phase: range(0, TAU), speed: 0.35 }));
      // ... and short cross ripples roughen the long crests.
      components.push(comp({ angle: base + sign() * range(25, 40) * deg, k: range(1.3, 1.5), weight: 0.22, phase: range(0, TAU), speed: -0.6 }));
      contrastMin = 0.3;
      bendBoost = 1.45;
      break;
    }
    case 'crosscurrent': {
      // Two currents at an oblique angle with unrelated spacings, so the crossings never
      // settle into a regular grid; the contrast field lets them weave only in patches.
      const a = range(0, 180) * deg;
      const b = a + sign() * range(55, 75) * deg;
      components.push(comp({ angle: a, phase: range(0, TAU), speed: 1 }));
      components.push(comp({ angle: b, k: range(1.3, 1.6), weight: 0.8, phase: range(0, TAU), speed: -0.8 }));
      contrastMin = 0.12;
      bendBoost = 1.25;
      break;
    }
    case 'bloom': {
      // Poisson-disk-like placement of 3-5 blooms of different strengths.
      const n = 3 + Math.floor(r() * 2);
      const pts: [number, number][] = [];
      for (let tries = 0; pts.length < n && tries < 400; tries++) {
        const p: [number, number] = [range(0.08, 0.92) * W, range(0.1, 0.9) * H];
        if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.32 * W)) pts.push(p);
      }
      for (const [x, y] of pts) {
        components.push(
          comp({ kind: 'ripple', x, y, k: 1, weight: range(0.55, 1), reach: range(1.3, 1.7), phase: range(0, TAU), speed: sign() * range(0.7, 1.1) }),
        );
      }
      // A faint background swell so the calm space between blooms still breathes.
      components.push(comp({ angle: range(0, 180) * deg, k: 0.45, weight: 0.15, phase: range(0, TAU), speed: 0.4 }));
      localNormalize = true;
      // The blooms themselves provide the contrast.
      contrastMin = 1;
      break;
    }
    case 'spiral': {
      const x = cx + range(-0.18, 0.18) * W, y = cy + range(-0.18, 0.18) * H;
      const arms = (2 + Math.floor(r() * 2)) * sign();
      components.push(comp({ kind: 'spiral', x, y, arms, phase: range(0, TAU), speed: 1 }));
      contrastMin = 0.55;
      break;
    }
  }

  const dir = (): [number, number] => {
    const a = range(0, TAU);
    return [Math.cos(a), Math.sin(a)];
  };
  const field = (length: number, speed: number): Field => ({ d: dir(), length, phase: range(0, TAU), speed });
  return {
    components,
    localNormalize,
    contrastMin,
    // Broad areas, about the size of a third to a half of the board.
    contrast: [field(range(1000, 1400), 0.25), field(range(700, 1000), -0.18)],
    bendBoost,
    // Two octaves of bend: a large sweep (4.5 spacings) and a smaller wobble (2.2 spacings),
    // each displacing along its own direction.
    bend: [field(4.5, 0.15), field(4.5, -0.12), field(2.2, 0.3), field(2.2, -0.25)],
    bendAngles: [range(0, TAU), range(0, TAU)],
    twist: field(range(900, 1300), 0.2),
  };
}

/** Wave spacing (mm) for a scale slider value. */
export function spacingFor(scale: number): number {
  const s = clamp01(scale);
  return LIMITS.minSpacing * Math.pow(LIMITS.maxSpacing / LIMITS.minSpacing, s);
}

/** Region that tips must stay inside: the original board minus its 2-inch border. */
export interface TipBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function tipBounds(sculpture: Sculpture): TipBounds {
  const b = sculpture.data.board;
  const border = sculpture.data.presentation.borderMm + LIMITS.borderClearance;
  return {
    minX: b.center[0] - b.widthMm / 2 + border,
    maxX: b.center[0] + b.widthMm / 2 - border,
    minY: b.center[1] - b.heightMm / 2 + border,
    maxY: b.center[1] + b.heightMm / 2 - border,
  };
}

/** Smooth upper limit: identity below hi - knee, eases toward hi above it. */
export function softMax(v: number, hi: number, knee: number): number {
  const start = hi - knee;
  if (v <= start) return v;
  return start + knee * Math.tanh((v - start) / knee);
}

export function softMin(v: number, lo: number, knee: number): number {
  return -softMax(-v, -lo, knee);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Measured size of a raw pattern, used to scale it to the limits. */
export interface PatternMeasure {
  /** Largest raw height and lean. */
  maxHeight: number;
  maxLean: number;
  /** Scale factors applied (mm per raw unit) at the given intensity and strength. */
  height: number;
  lean: number;
  /** Resulting largest lean, and largest lean difference between adjacent tips per 50 mm. */
  leanMm: number;
  stepMm: number;
  spacing: number;
}

/**
 * Pose offsets (tip - anchor, 3 per piece) for a variation at time t (seconds).
 * The result depends only on (variation, t).
 */
export class VariationEngine {
  readonly bounds: TipBounds;
  private readonly W: number;
  private readonly H: number;
  private cache: { key: string; recipe: Recipe } | null = null;
  private readonly rz: Float64Array;
  private readonly rx: Float64Array;
  private readonly ry: Float64Array;
  /** How calm each piece's area is (0 = fully active, 1 = calmest). */
  private readonly calm: Float64Array;
  private readonly ox: Float64Array;
  private readonly oy: Float64Array;
  private readonly bx: Float64Array;
  private readonly f: Float64Array;
  private readonly g: Float64Array;
  /** Neighbors of each piece (8-neighborhood), compressed: list[start[i] .. start[i + 1]). */
  private readonly adjacency: { start: Int32Array; list: Int32Array };
  /** Neighbor pairs (i, j, 50 / distance) along rows, columns and both diagonals. */
  private readonly pairs: { i: Int32Array; j: Int32Array; w: Float64Array };
  /** Measurement of the most recent pose. */
  last: PatternMeasure | null = null;

  constructor(readonly sculpture: Sculpture) {
    this.bounds = tipBounds(sculpture);
    this.W = sculpture.cols * sculpture.spacing;
    this.H = sculpture.rows * sculpture.spacing;
    const n = sculpture.count;
    this.rz = new Float64Array(n);
    this.rx = new Float64Array(n);
    this.ry = new Float64Array(n);
    this.calm = new Float64Array(n);
    this.ox = new Float64Array(n);
    this.oy = new Float64Array(n);
    this.bx = new Float64Array(n);
    this.f = new Float64Array(n);
    this.g = new Float64Array(n);
    const I: number[] = [], J: number[] = [], Wt: number[] = [];
    const { cols, rows } = sculpture;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
          const c2 = c + dc, r2 = r + dr;
          if (c2 < 0 || c2 >= cols || r2 >= rows) continue;
          I.push(r * cols + c);
          J.push(r2 * cols + c2);
          Wt.push(1 / Math.hypot(dc, dr));
        }
      }
    }
    this.pairs = { i: Int32Array.from(I), j: Int32Array.from(J), w: Float64Array.from(Wt) };
    const nbrs: number[][] = Array.from({ length: n }, () => []);
    I.forEach((i, p) => {
      nbrs[i].push(J[p]);
      nbrs[J[p]].push(i);
    });
    const start = new Int32Array(n + 1);
    nbrs.forEach((l, i) => (start[i + 1] = start[i] + l.length));
    this.adjacency = { start, list: Int32Array.from(nbrs.flat()) };
  }

  private recipeFor(style: Exclude<StyleId, 'original'>, seed: number): Recipe {
    const key = `${style}:${seed}`;
    if (this.cache?.key !== key) this.cache = { key, recipe: recipe(style, seed, this.W, this.H) };
    return this.cache.recipe;
  }

  /** Writes the offsets for (v, t) into `out`. `strength` scales the pattern (safety net). */
  offsets(v: Variation, t: number, out: Float64Array = new Float64Array(this.sculpture.count * 3), strength = 1): Float64Array {
    const s = this.sculpture;
    if (v.style === 'original') {
      out.set(s.originalOffsets);
      this.last = null;
      return out;
    }
    const rec = this.recipeFor(v.style, v.seed);
    const spacing = spacingFor(v.scale);
    const k0 = TAU / spacing;
    const flow = clamp01(v.flow);
    const w0 = BASE_OMEGA * t;
    const a = s.anchors;
    const n = s.count;
    const { rz, rx, ry, calm } = this;

    // Bend: a large sweep and a smaller wobble. Their gradients stay below about 0.6 each, so
    // fronts bend and meander without folding over.
    const bendLarge = Math.min(0.42, (0.13 + 0.22 * flow) * rec.bendBoost) * spacing;
    const bendSmall = Math.min(0.2, (0.03 + 0.12 * flow) * rec.bendBoost) * spacing;
    const [bl1, bl2, bs1, bs2] = rec.bend;
    const [ang1, ang2] = rec.bendAngles;
    const wave = (f: Field, px: number, py: number, length: number) =>
      Math.sin((TAU / length) * (px * f.d[0] + py * f.d[1]) + f.phase + f.speed * w0);
    // Twist: the lean direction turns by up to ±(15°…45°) across the board.
    const twistAmp = 0.26 + 0.52 * flow;
    const totalWeight = rec.components.reduce((acc, c) => acc + c.weight, 0);

    for (let i = 0; i < n; i++) {
      const px = a[i * 3], py = a[i * 3 + 1];
      const u1 = wave(bl1, px, py, bl1.length * spacing) * bendLarge;
      const u2 = wave(bl2, px, py, bl2.length * spacing) * bendLarge;
      const u3 = wave(bs1, px, py, bs1.length * spacing) * bendSmall;
      const u4 = wave(bs2, px, py, bs2.length * spacing) * bendSmall;
      const qx = px + (u1 + u3) * Math.cos(ang1) + (u2 + u4) * Math.cos(ang2);
      const qy = py + (u1 + u3) * Math.sin(ang1) + (u2 + u4) * Math.sin(ang2);

      let z = 0, lx = 0, ly = 0, coverage = 0, local = 0;
      for (const c of rec.components) {
        const dx = qx - c.x, dy = qy - c.y;
        const r = Math.hypot(dx, dy);
        let e = c.weight;
        if (Number.isFinite(c.reach)) {
          const R = c.reach * spacing;
          if (r >= R) continue;
          const u = 1 - r / R;
          e *= u * u * u * (u * (u * 6 - 15) + 10);
        }
        const ph = c.phase + c.speed * w0;
        let sPhase: number, ux: number, uy: number;
        if (c.kind === 'travel') {
          ux = Math.cos(c.angle);
          uy = Math.sin(c.angle);
          sPhase = k0 * c.k * (dx * ux + dy * uy) - ph;
        } else {
          const eps = spacing / 6;
          const inv = 1 / Math.sqrt(r * r + eps * eps);
          ux = dx * inv;
          uy = dy * inv;
          sPhase = k0 * c.k * r - ph;
          if (c.kind === 'spiral') {
            sPhase += c.arms * Math.atan2(dy, dx);
            // Calm the center, where the arms converge.
            const core = Math.min(1, r / (1.2 * spacing));
            e *= core * core * (3 - 2 * core);
          }
        }
        if (c.sharp) sPhase -= c.sharp * Math.sin(sPhase);
        z += e * Math.sin(sPhase);
        const lat = e * Math.cos(sPhase);
        lx += lat * ux;
        ly += lat * uy;
        coverage += e;
        if (Number.isFinite(c.reach)) local += e;
      }
      const norm = rec.localNormalize ? Math.max(1, coverage) : totalWeight;
      // Contrast: calm and strong areas.
      let env = 1;
      if (rec.contrastMin < 1) {
        const [c1, c2] = rec.contrast;
        const u = 0.5 + 0.5 * (0.62 * wave(c1, px, py, c1.length) + 0.38 * wave(c2, px, py, c2.length));
        const active = smoothstep(0.12, 0.88, u);
        env = rec.contrastMin + (1 - rec.contrastMin) * active;
        calm[i] = 1 - active;
      } else {
        // Blooms: calm between the flowers.
        calm[i] = rec.localNormalize ? 1 - smoothstep(0.05, 0.6, local) : 0;
      }
      const g = env / norm;
      // Twist the lean direction.
      const tw = twistAmp * wave(rec.twist, px, py, rec.twist.length);
      const ct = Math.cos(tw), st = Math.sin(tw);
      rz[i] = z * g;
      rx[i] = (lx * ct - ly * st) * g;
      ry[i] = (lx * st + ly * ct) * g;
    }

    // Scale the raw pattern so its strongest area reaches the limits.
    const intensity = clamp01(v.intensity) * strength;
    const calmLean = (intensity * LIMITS.calmLean) / Math.SQRT2;
    let maxZ = 1e-12, maxL = 1e-12;
    for (let i = 0; i < n; i++) {
      maxZ = Math.max(maxZ, Math.abs(rz[i]));
      maxL = Math.max(maxL, Math.hypot(rx[i], ry[i]));
    }
    const H = (intensity * LIMITS.heightAmplitude) / maxZ;
    const L = (intensity * LIMITS.maxLean) / maxL;

    // Lean vectors in mm: the wave part (magnitude softly capped) plus the calm lean.
    const { ox, oy, bx, f, g } = this;
    for (let i = 0; i < n; i++) {
      let wx = L * rx[i], wy = L * ry[i];
      const m = Math.hypot(wx, wy);
      if (m > 0) {
        const mm = softMax(m, LIMITS.maxLean, 12);
        wx *= mm / m;
        wy *= mm / m;
      }
      bx[i] = calmLean * calm[i];
      ox[i] = wx + bx[i];
      oy[i] = wy + bx[i];
    }

    // Neighbor limit, applied locally: where adjacent tips would differ by more than the step
    // limit, the wave part is eased back toward the calm lean in that neighborhood only
    // (smoothly), so broad areas keep their far-reaching leans. A final global factor
    // guarantees the limit exactly.
    const cap = intensity * LIMITS.neighborLeanStep;
    const P = this.pairs;
    const { start, list } = this.adjacency;
    let worst = 0;
    for (let pass = 0; pass < 6 && cap > 0; pass++) {
      f.fill(1);
      worst = 0;
      for (let p = 0; p < P.i.length; p++) {
        const i = P.i[p], j = P.j[p];
        const step = Math.hypot(ox[i] - ox[j], oy[i] - oy[j]) * P.w[p];
        const ratio = step / cap;
        if (ratio > worst) worst = ratio;
        if (ratio > 1) {
          const k = 1 / ratio;
          if (k < f[i]) f[i] = k;
          if (k < f[j]) f[j] = k;
        }
      }
      if (worst <= 1) break;
      // Spread each reduction to the surrounding pieces (erode, then blur) so it fades in.
      for (let i = 0; i < n; i++) {
        let lo = f[i];
        for (let q = start[i]; q < start[i + 1]; q++) lo = Math.min(lo, f[list[q]]);
        g[i] = lo;
      }
      for (let i = 0; i < n; i++) {
        let sum = g[i], cnt = 1;
        for (let q = start[i]; q < start[i + 1]; q++) {
          sum += g[list[q]];
          cnt++;
        }
        const k = Math.min(g[i] * 0.5 + (sum / cnt) * 0.5, f[i]) * 0.985;
        ox[i] = bx[i] + (ox[i] - bx[i]) * k;
        oy[i] = bx[i] + (oy[i] - bx[i]) * k;
      }
    }
    // Guarantee: scale the wave part globally until nothing is left over. (The calm lean is not
    // scaled, so this can take a few rounds; its own differences are far below the limit.)
    for (let round = 0; round < 12; round++) {
      worst = 0;
      for (let p = 0; p < P.i.length; p++) {
        const i = P.i[p], j = P.j[p];
        worst = Math.max(worst, (Math.hypot(ox[i] - ox[j], oy[i] - oy[j]) * P.w[p]) / Math.max(cap, 1e-12));
      }
      if (worst <= 1) break;
      const k = round < 11 ? 0.995 / worst : 0;
      for (let i = 0; i < n; i++) {
        ox[i] = bx[i] + (ox[i] - bx[i]) * k;
        oy[i] = bx[i] + (oy[i] - bx[i]) * k;
      }
    }
    let leanMax = 0, stepMax = 0;
    for (let i = 0; i < n; i++) leanMax = Math.max(leanMax, Math.hypot(ox[i], oy[i]));
    for (let p = 0; p < P.i.length; p++) {
      const i = P.i[p], j = P.j[p];
      stepMax = Math.max(stepMax, Math.hypot(ox[i] - ox[j], oy[i] - oy[j]) * P.w[p]);
    }
    this.last = { maxHeight: maxZ, maxLean: maxL, height: H, lean: L, leanMm: leanMax, stepMm: stepMax, spacing };

    const b = this.bounds;
    for (let i = 0; i < n; i++) {
      const px = a[i * 3], py = a[i * 3 + 1];
      let tz = LIMITS.restHeight + H * rz[i] - intensity * LIMITS.calmDrop * calm[i];
      tz = softMin(softMax(tz, LIMITS.maxHeight, 10), LIMITS.minHeight, 8);
      let tx = px + ox[i], ty = py + oy[i];
      tx = softMin(softMax(tx, b.maxX, 14), b.minX, 14);
      ty = softMin(softMax(ty, b.maxY, 14), b.minY, 14);
      out[i * 3] = tx - px;
      out[i * 3 + 1] = ty - py;
      out[i * 3 + 2] = tz - a[i * 3 + 2];
    }
    return out;
  }
}

export interface SafetyResult {
  /** Pattern strength that was used (1 = unchanged). */
  strength: number;
  /** Complete checks run (for measurements). */
  checks: number;
}

/**
 * Final safety net: runs the complete geometry check and, if anything at all is reported
 * (error or warning), lowers the pattern strength until the pose is clean.
 */
export function makeSafe(
  engine: VariationEngine,
  v: Variation,
  t: number,
  out: Float64Array,
  maxStrength = 1,
): SafetyResult {
  const s = engine.sculpture;
  const tips = new Float64Array(s.count * 3);
  let checks = 0;
  const clean = (strength: number) => {
    engine.offsets(v, t, out, strength);
    const { outer, inner } = s.shellVertices(s.tipsFromOffsets(out, tips));
    checks++;
    return validateShells(s, outer, inner).issues.length === 0;
  };
  if (v.style === 'original' || clean(maxStrength)) return { strength: maxStrength, checks };
  let lo = 0, hi = maxStrength;
  for (let step = 0; step < 8; step++) {
    const mid = (lo + hi) / 2;
    if (clean(mid)) lo = mid;
    else hi = mid;
  }
  // Leave `out` holding the clean pose.
  if (!clean(lo)) {
    engine.offsets(v, t, out, 0);
    return { strength: 0, checks };
  }
  return { strength: lo, checks };
}
