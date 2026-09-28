/**
 * Wave sources: deterministic XYZ offset fields sampled at the fixed base-grid anchors.
 *
 * Circular ripple (distance r from the source, falloff E(r), s = 2 pi r / spacing - phase):
 *   dz  = E(r) * height * sin(s)
 *   dxy = E(r) * lean   * cos(s) * radial direction
 * The radial direction is (p - c) / sqrt(r^2 + eps^2), which fades smoothly to zero at the
 * source center (no division by zero, no direction flip).
 *
 * Traveling wave: the same, with r replaced by the projection u = (p - c) . d and the radial
 * direction replaced by the travel direction d.
 */

export type WaveKind = 'ripple' | 'travel';

export interface WaveSource {
  id: string;
  kind: WaveKind;
  /** Source position on the board (mm). */
  x: number;
  y: number;
  /** Peak height change (mm). */
  height: number;
  /** Peak sideways lean (mm). Positive leans away from the source on the rising side. */
  lean: number;
  /** Distance between crests (mm). */
  spacing: number;
  /** Falloff radius (mm). Infinity = whole board. */
  reach: number;
  /** Travel direction for traveling waves, degrees counterclockwise from +X. */
  direction: number;
  /** Cycles per loop. Positive travels outward / along the direction; 0 = standing pattern. */
  speed: number;
  /** Extra phase for this source (degrees). */
  phaseOffset: number;
  enabled: boolean;
}

export const WAVE_LIMITS = {
  /** Four samples per wavelength on the 50 mm grid keeps crests cleanly represented. */
  spacing: { min: 200, max: 1400 },
  reach: { min: 100, max: 2000 },
  height: { normal: 30, extended: 60 },
  lean: { normal: 30, extended: 60 },
  speed: { min: -2, max: 2, step: 0.25 },
} as const;

export function defaultSource(id: string, kind: WaveKind, x: number, y: number): WaveSource {
  return {
    id,
    kind,
    x,
    y,
    height: 0,
    lean: 0,
    spacing: kind === 'ripple' ? 450 : 600,
    reach: kind === 'ripple' ? 900 : Infinity,
    direction: 0,
    speed: 1,
    phaseOffset: 0,
    enabled: true,
  };
}

/** Quintic smootherstep falloff: 1 at the center, 0 at the reach, flat at both ends. */
export function falloff(r: number, reach: number): number {
  if (!Number.isFinite(reach)) return 1;
  if (r >= reach) return 0;
  const t = 1 - r / reach;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Number of global phase turns after which every source returns to its starting pose. */
export function loopTurns(sources: readonly WaveSource[]): number {
  let q = 1;
  for (const s of sources) {
    if (!s.enabled) continue;
    while (q < 64 && Math.abs(s.speed * q - Math.round(s.speed * q)) > 1e-9) q *= 2;
  }
  return q;
}

/** Local phase (radians) of a source at global phase `phase` (radians). */
export function sourcePhase(src: WaveSource, phase: number): number {
  return src.speed * phase + (src.phaseOffset * Math.PI) / 180;
}

/**
 * Adds the offset of one source, evaluated at board position (px, py), to out[o..o+2].
 * Always sampled at the fixed grid anchor, never at a displaced tip.
 */
export function addSourceOffset(
  src: WaveSource,
  px: number,
  py: number,
  phase: number,
  out: Float64Array,
  o: number,
  weight = 1,
): void {
  if (!src.enabled || (src.height === 0 && src.lean === 0)) return;
  const dx = px - src.x;
  const dy = py - src.y;
  const r = Math.hypot(dx, dy);
  const e = falloff(r, src.reach) * weight;
  if (e === 0) return;
  const k = (2 * Math.PI) / src.spacing;
  const ph = sourcePhase(src, phase);
  let s: number, ux: number, uy: number;
  if (src.kind === 'ripple') {
    s = k * r - ph;
    const eps = src.spacing / 6;
    const inv = 1 / Math.sqrt(r * r + eps * eps);
    ux = dx * inv;
    uy = dy * inv;
  } else {
    const a = (src.direction * Math.PI) / 180;
    ux = Math.cos(a);
    uy = Math.sin(a);
    s = k * (dx * ux + dy * uy) - ph;
  }
  const lat = e * src.lean * Math.cos(s);
  out[o] += lat * ux;
  out[o + 1] += lat * uy;
  out[o + 2] += e * src.height * Math.sin(s);
}

/**
 * Wave field for all anchors: out[i] = sum of source offsets at anchor i.
 * `out` is overwritten.
 */
export function evaluateWaveField(
  sources: readonly WaveSource[],
  anchors: Float64Array,
  phase: number,
  out: Float64Array,
): Float64Array {
  out.fill(0);
  const n = anchors.length / 3;
  for (const src of sources) {
    for (let i = 0; i < n; i++) addSourceOffset(src, anchors[i * 3], anchors[i * 3 + 1], phase, out, i * 3);
  }
  return out;
}

export function hasActiveWaves(sources: readonly WaveSource[]): boolean {
  return sources.some((s) => s.enabled && (s.height !== 0 || s.lean !== 0));
}
