/**
 * Pattern variations: a style plus three sliders (intensity, scale, flow) and a seed produce a
 * complete pose for all 522 pyramids, with no manual editing.
 *
 * Every style is a small set of wave components evaluated at the fixed base-grid anchors, the
 * same model the original sculpture follows: along each wave, height follows sin(s) and the
 * sideways lean follows cos(s) in the wave's direction, so crests lean as they rise and fall.
 * Flow bends the wave fronts with a gentle, slowly drifting domain warp.
 *
 * Geometry limits (see LIMITS) are built into the mapping, so a variation cannot produce
 * pyramids that are too short, fall toward the board, lean into their neighbors, or reach into
 * the 2-inch border of the original board. `makeSafe` is a final safety net that checks the
 * shells and, if needed, tones the variation down; it is not expected to change anything.
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
  /** 0 = straight, regular fronts, 1 = strongly curving, organic fronts. */
  flow: number;
  /** Shuffle: picks new positions, angles and timing for the style. */
  seed: number;
}

export const STYLES: readonly { id: StyleId; name: string; description: string }[] = [
  { id: 'original', name: 'Original', description: 'The sculpture as it was made.' },
  { id: 'drift', name: 'Drift', description: 'Diagonal bands that lean as they roll, like the original.' },
  { id: 'ripple', name: 'Ripple', description: 'Rings spreading from a point, like a stone dropped in water.' },
  { id: 'dunes', name: 'Dunes', description: 'Long crests with a gentle rise and a steep fall.' },
  { id: 'crosscurrent', name: 'Crosscurrent', description: 'Two currents crossing into a woven lattice.' },
  { id: 'bloom', name: 'Bloom', description: 'Separate flowers of rings with calm space between them.' },
  { id: 'spiral', name: 'Spiral', description: 'Arms curling around a center.' },
];

export const DEFAULT_VARIATION: Variation = { style: 'original', intensity: 0.85, scale: 0.5, flow: 0.3, seed: 1 };

/** Starting values when a style is first chosen. */
export const STYLE_DEFAULTS: Record<Exclude<StyleId, 'original'>, Pick<Variation, 'intensity' | 'scale' | 'flow'>> = {
  drift: { intensity: 0.9, scale: 0.5, flow: 0.35 },
  ripple: { intensity: 0.9, scale: 0.45, flow: 0.15 },
  dunes: { intensity: 0.85, scale: 0.6, flow: 0.55 },
  crosscurrent: { intensity: 0.85, scale: 0.5, flow: 0.25 },
  bloom: { intensity: 1, scale: 0.35, flow: 0.15 },
  spiral: { intensity: 0.85, scale: 0.45, flow: 0.1 },
};

/**
 * Geometry limits (mm). Heights stay within the character of the original (27–71 mm tips),
 * leans stay below the point where a tip could reach its neighbor, and all tips stay inside the
 * original board's 2-inch border.
 */
export const LIMITS = {
  /** Resting tip height of the variations (close to the original median, 47 mm). */
  restHeight: 46,
  minHeight: 22,
  maxHeight: 76,
  /** Height change at full intensity. */
  heightAmplitude: 24,
  /** Largest sideways lean of any tip. */
  maxLean: 62,
  /**
   * Largest lean change between adjacent pieces (50 mm apart) that the lean amplitude is
   * sized for. Adjacent tips that converge by much more than this could touch.
   */
  neighborLeanStep: 56,
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

interface Recipe {
  components: Component[];
  /** Normalize by local coverage instead of total weight (separate blooms). */
  localNormalize: boolean;
  /** Highest local wavenumber relative to 2π / spacing, used to size the lean. */
  kMax: number;
  warp: { a1: number; a2: number; p1: number; p2: number; d1: [number, number]; d2: [number, number] };
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
  let kMax = 1;

  switch (style) {
    case 'drift': {
      // Travel close to the (1, 1) diagonal, like the original's bands. Leaning along that
      // diagonal is what opens each pyramid's open side toward the viewer (blue shows) or
      // closes it (black shows); leaning across it would barely change the colors.
      const base = (range(15, 75) + (r() < 0.5 ? 180 : 0)) * deg;
      const turn = sign() * range(12, 24) * deg;
      components.push(comp({ angle: base, phase: range(0, TAU), speed: 1 }));
      components.push(comp({ angle: base + turn, k: range(0.58, 0.7), weight: 0.55, phase: range(0, TAU), speed: 0.7 }));
      kMax = 1;
      break;
    }
    case 'ripple': {
      const x = cx + range(-0.32, 0.32) * W, y = cy + range(-0.3, 0.3) * H;
      components.push(comp({ kind: 'ripple', x, y, phase: range(0, TAU), speed: 1 }));
      const x2 = x < cx ? range(0.7, 1) * W : range(0, 0.3) * W;
      const y2 = y < cy ? range(0.65, 1) * H : range(0, 0.35) * H;
      components.push(comp({ kind: 'ripple', x: x2, y: y2, k: range(1.1, 1.3), weight: 0.35, phase: range(0, TAU), speed: 0.8 }));
      kMax = 1.3;
      break;
    }
    case 'dunes': {
      const base = (90 + sign() * range(0, 22)) * deg;
      components.push(comp({ angle: base, phase: range(0, TAU), speed: 0.8, sharp: range(0.45, 0.6) }));
      // A second, longer swell along the diagonal makes the crests meander and merge like real
      // dunes (along the diagonal its lean also shows as color, not only as height).
      const swell = (45 + range(-10, 10) + (r() < 0.5 ? 180 : 0)) * deg;
      components.push(comp({ angle: swell, k: range(0.5, 0.65), weight: 0.55, phase: range(0, TAU), speed: 0.35 }));
      // The dune profile steepens the lee side: local wavenumber up to 1 + sharp.
      kMax = 1.6;
      break;
    }
    case 'crosscurrent': {
      // Two currents roughly along X and Y: both lean partly along the diagonal, so their
      // crossings weave a checker of open (colored) and closed pyramids.
      const a = (range(-18, 18) + (r() < 0.5 ? 180 : 0)) * deg;
      const b = a + sign() * range(80, 100) * deg;
      components.push(comp({ angle: a, phase: range(0, TAU), speed: 1 }));
      components.push(comp({ angle: b, k: range(0.85, 1.1), weight: 0.9, phase: range(0, TAU), speed: -0.8 }));
      kMax = 1.1;
      break;
    }
    case 'bloom': {
      // Poisson-disk-like placement of 3-5 blooms.
      const n = 3 + Math.floor(r() * 3);
      const pts: [number, number][] = [];
      for (let tries = 0; pts.length < n && tries < 400; tries++) {
        const p: [number, number] = [range(0.08, 0.92) * W, range(0.1, 0.9) * H];
        if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.3 * W)) pts.push(p);
      }
      for (const [x, y] of pts) {
        components.push(comp({ kind: 'ripple', x, y, k: 1.15, reach: range(1.35, 1.8), phase: range(0, TAU), speed: sign() * range(0.7, 1.1) }));
      }
      // A faint background swell so the calm space between blooms still breathes.
      components.push(comp({ angle: range(0, 180) * deg, k: 0.45, weight: 0.22, phase: range(0, TAU), speed: 0.4 }));
      localNormalize = true;
      // Falloff edges add slope to the ring pattern.
      kMax = 1.45;
      break;
    }
    case 'spiral': {
      const x = cx + range(-0.18, 0.18) * W, y = cy + range(-0.18, 0.18) * H;
      const arms = (2 + Math.floor(r() * 3)) * sign();
      components.push(comp({ kind: 'spiral', x, y, arms, phase: range(0, TAU), speed: 1 }));
      kMax = 1.35;
      break;
    }
  }

  const warpAngle = range(0, 180) * deg;
  const warp = {
    a1: range(0, TAU),
    a2: range(0, TAU),
    p1: range(0, TAU),
    p2: range(0, TAU),
    d1: [Math.cos(warpAngle), Math.sin(warpAngle)] as [number, number],
    d2: [Math.cos(warpAngle + 1.9), Math.sin(warpAngle + 1.9)] as [number, number],
  };
  return { components, localNormalize, kMax, warp };
}

/** Wave spacing (mm) for a scale slider value. */
export function spacingFor(scale: number): number {
  const s = clamp01(scale);
  return LIMITS.minSpacing * Math.pow(LIMITS.maxSpacing / LIMITS.minSpacing, s);
}

/** Warp displacement as a fraction of the spacing at flow = 1 (keeps local wavelengths sane). */
const WARP_AMPLITUDE = 0.2;
/** Warp wavelength in spacings. */
const WARP_LENGTH = 2.3;

/** Lean and height amplitudes (mm) for a variation. */
export function amplitudes(v: Variation, kMax: number): { height: number; lean: number; spacing: number } {
  const spacing = spacingFor(v.scale);
  const intensity = clamp01(v.intensity);
  // Local wavenumber including the warp's compression (its gradient is at most 2π A / L).
  const warpGain = 1 + (TAU * WARP_AMPLITUDE * clamp01(v.flow)) / WARP_LENGTH;
  const k = (TAU / spacing) * kMax * warpGain;
  // Adjacent pieces are 50 mm apart: the lean changes by about lean * k * 50 between them.
  const leanForStep = LIMITS.neighborLeanStep / (k * 50);
  return {
    height: intensity * LIMITS.heightAmplitude,
    lean: intensity * Math.min(LIMITS.maxLean, leanForStep),
    spacing,
  };
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

/**
 * Pose offsets (tip - anchor, 3 per piece) for a variation at time t (seconds).
 * The result depends only on (variation, t).
 */
export class VariationEngine {
  readonly bounds: TipBounds;
  private readonly W: number;
  private readonly H: number;
  private cache: { key: string; recipe: Recipe } | null = null;

  constructor(readonly sculpture: Sculpture) {
    this.bounds = tipBounds(sculpture);
    this.W = sculpture.cols * sculpture.spacing;
    this.H = sculpture.rows * sculpture.spacing;
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
      return out;
    }
    const rec = this.recipeFor(v.style, v.seed);
    const amp = amplitudes(v, rec.kMax);
    const H = amp.height * strength;
    const L = amp.lean * strength;
    const k0 = TAU / amp.spacing;
    const flow = clamp01(v.flow);
    const warpA = WARP_AMPLITUDE * flow * amp.spacing;
    const kw = TAU / (WARP_LENGTH * amp.spacing);
    const wt = (TAU / 60) * t; // the warp drifts once a minute
    const w = rec.warp;
    const totalWeight = rec.components.reduce((a, c) => a + c.weight, 0);
    const b = this.bounds;
    const a = s.anchors;

    for (let i = 0; i < s.count; i++) {
      const px = a[i * 3], py = a[i * 3 + 1];
      // Domain warp: bend the wave fronts.
      let qx = px, qy = py;
      if (warpA > 0) {
        const u1 = Math.sin(kw * (px * w.d1[0] + py * w.d1[1]) + w.p1 + wt);
        const u2 = Math.sin(kw * (px * w.d2[0] + py * w.d2[1]) + w.p2 - 0.7 * wt);
        qx += warpA * (u1 * Math.cos(w.a1) + u2 * Math.cos(w.a2));
        qy += warpA * (u1 * Math.sin(w.a1) + u2 * Math.sin(w.a2));
      }
      let z = 0, lx = 0, ly = 0, coverage = 0;
      for (const c of rec.components) {
        const dx = qx - c.x, dy = qy - c.y;
        const r = Math.hypot(dx, dy);
        let e = c.weight;
        if (Number.isFinite(c.reach)) {
          const R = c.reach * amp.spacing;
          if (r >= R) continue;
          const u = 1 - r / R;
          e *= u * u * u * (u * (u * 6 - 15) + 10);
        }
        const ph = c.phase + c.speed * BASE_OMEGA * t;
        let sPhase: number, ux: number, uy: number;
        if (c.kind === 'travel') {
          ux = Math.cos(c.angle);
          uy = Math.sin(c.angle);
          sPhase = k0 * c.k * (dx * ux + dy * uy) - ph;
        } else {
          const eps = amp.spacing / 6;
          const inv = 1 / Math.sqrt(r * r + eps * eps);
          ux = dx * inv;
          uy = dy * inv;
          sPhase = k0 * c.k * r - ph;
          if (c.kind === 'spiral') {
            sPhase += c.arms * Math.atan2(dy, dx);
            // Calm the center, where the arms converge.
            const core = Math.min(1, r / (0.9 * amp.spacing));
            e *= core * core * (3 - 2 * core);
          }
        }
        if (c.sharp) sPhase -= c.sharp * Math.sin(sPhase);
        z += e * Math.sin(sPhase);
        const lat = e * Math.cos(sPhase);
        lx += lat * ux;
        ly += lat * uy;
        coverage += e;
      }
      const norm = rec.localNormalize ? Math.max(1, coverage) : totalWeight;
      z /= norm;
      lx /= norm;
      ly /= norm;

      // Heights: rest height plus the wave, softly kept inside the limits.
      let tz = LIMITS.restHeight + H * z;
      tz = softMin(softMax(tz, LIMITS.maxHeight, 10), LIMITS.minHeight, 8);
      // Lean: magnitude softly capped, then the tip is kept inside the board's border.
      let ox = L * lx, oy = L * ly;
      const m = Math.hypot(ox, oy);
      if (m > 0) {
        const mm = softMax(m, LIMITS.maxLean, 12);
        ox *= mm / m;
        oy *= mm / m;
      }
      let tx = px + ox, ty = py + oy;
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
