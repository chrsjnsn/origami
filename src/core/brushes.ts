/**
 * Local refinement brushes. Pieces are selected by their fixed grid anchors (never by the
 * displaced tips), with a smooth falloff. Strength is a rate per second of stroke time and is
 * integrated in fixed sub-steps, so results do not depend on the frame rate.
 */

import type { Sculpture } from './sculpture';
import { GridStencils, REFERENCE_LAMBDA, smoothDab } from './smoothing';
import { falloff } from './waves';

export type BrushKind = 'height' | 'leanX' | 'leanY' | 'smooth' | 'restore';
export type SmoothAxis = 'x' | 'y' | 'z' | 'all';

export interface BrushSettings {
  kind: BrushKind;
  /** Footprint radius (mm). */
  radius: number;
  /** 1 to 10. Height/lean: 3 mm/s per step at the center. Smooth/restore: blend rate. */
  strength: number;
  /** +1 raises / leans toward +X or +Y; -1 the opposite. */
  sign: 1 | -1;
  smoothAxis: SmoothAxis;
  /** 0..1, 0.5 = reference smoothing weight 0.12. */
  smoothness: number;
}

export const BRUSH_RANGE = {
  radius: { min: 50, max: 600 },
  strength: { min: 1, max: 10 },
};

/** Creative bounds for edits. Existing values outside the bounds are never snapped. */
export const EDIT_LIMITS = {
  normal: { minHeight: 10, maxHeight: 110, lean: 65 },
  extended: { minHeight: 3, maxHeight: 160, lean: 110 },
} as const;

export type EditLimits = (typeof EDIT_LIMITS)['normal'] | (typeof EDIT_LIMITS)['extended'];

export function defaultBrush(kind: BrushKind = 'height'): BrushSettings {
  return { kind, radius: 160, strength: 5, sign: 1, smoothAxis: 'all', smoothness: 0.5 };
}

export function brushMmPerSecond(strength: number): number {
  return 3 * strength;
}

export function smoothnessToLambda(smoothness: number): number {
  return REFERENCE_LAMBDA * Math.pow(2, (smoothness - 0.5) * 4);
}

export function axisOf(kind: BrushKind): number {
  return kind === 'leanX' ? 0 : kind === 'leanY' ? 1 : 2;
}

/** Brush weights for every piece whose fixed anchor lies inside the footprint. */
export function brushWeights(sculpture: Sculpture, cx: number, cy: number, radius: number): Map<number, number> {
  const out = new Map<number, number>();
  const s = sculpture.spacing;
  const c0 = Math.max(0, Math.floor((cx - radius) / s) - 1);
  const c1 = Math.min(sculpture.cols - 1, Math.ceil((cx + radius) / s) + 1);
  const r0 = Math.max(0, Math.floor((cy - radius) / s) - 1);
  const r1 = Math.min(sculpture.rows - 1, Math.ceil((cy + radius) / s) + 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * sculpture.cols + c;
      const w = falloff(Math.hypot(sculpture.anchors[i * 3] - cx, sculpture.anchors[i * 3 + 1] - cy), radius);
      if (w > 0) out.set(i, w);
    }
  }
  return out;
}

export function clampToLimits(
  axis: number,
  anchorZ: number,
  next: number,
  previous: number,
  limits: EditLimits,
): number {
  let lo: number, hi: number;
  if (axis === 2) {
    lo = limits.minHeight - anchorZ;
    hi = limits.maxHeight - anchorZ;
  } else {
    lo = -limits.lean;
    hi = limits.lean;
  }
  return Math.min(Math.max(hi, previous), Math.max(Math.min(lo, previous), next));
}

export interface BrushContext {
  sculpture: Sculpture;
  grid: GridStencils;
  /** Editable offsets (the base layer). Modified in place. */
  offsets: Float64Array;
  /** Restore target offsets. */
  restoreTarget: Float64Array;
  limits: EditLimits;
}

/** Apply `dt` seconds of the brush centered at (cx, cy). */
export function applyBrush(ctx: BrushContext, brush: BrushSettings, cx: number, cy: number, dt: number): void {
  const weights = brushWeights(ctx.sculpture, cx, cy, brush.radius);
  if (weights.size === 0 || dt <= 0) return;
  const { offsets, sculpture } = ctx;
  switch (brush.kind) {
    case 'height':
    case 'leanX':
    case 'leanY': {
      const axis = axisOf(brush.kind);
      const rate = brush.sign * brushMmPerSecond(brush.strength) * dt;
      for (const [i, w] of weights) {
        const j = i * 3 + axis;
        const prev = offsets[j];
        offsets[j] = clampToLimits(axis, sculpture.anchors[i * 3 + 2], prev + rate * w, prev, ctx.limits);
      }
      break;
    }
    case 'smooth': {
      const axes = brush.smoothAxis === 'all' ? [0, 1, 2] : [{ x: 0, y: 1, z: 2 }[brush.smoothAxis]];
      const amount = 1 - Math.exp(-0.6 * brush.strength * dt);
      smoothDab(ctx.grid, offsets, weights, axes, smoothnessToLambda(brush.smoothness), amount);
      break;
    }
    case 'restore': {
      const amount = 1 - Math.exp(-0.5 * brush.strength * dt);
      for (const [i, w] of weights) {
        const f = Math.min(1, amount * w);
        for (let k = 0; k < 3; k++) {
          const j = i * 3 + k;
          offsets[j] += f * (ctx.restoreTarget[j] - offsets[j]);
        }
      }
      break;
    }
  }
}

/**
 * One continuous stroke. Pointer samples (x, y, t in seconds) are integrated in fixed
 * sub-steps with linear interpolation of the brush position, so a stroke produces the same
 * result whether it was sampled at 30 or 144 frames per second.
 */
export class Stroke {
  static readonly SUBSTEP = 1 / 120;
  static readonly INITIAL_DAB = 0.08;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private pending = 0;
  active = false;

  constructor(private readonly apply: (x: number, y: number, dt: number) => void) {}

  begin(x: number, y: number, t: number): void {
    this.active = true;
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;
    this.pending = 0;
    let remaining = Stroke.INITIAL_DAB;
    while (remaining > 1e-12) {
      const h = Math.min(Stroke.SUBSTEP, remaining);
      this.apply(x, y, h);
      remaining -= h;
    }
  }

  move(x: number, y: number, t: number): void {
    if (!this.active) return;
    const elapsed = Math.max(0, Math.min(0.25, t - this.lastT));
    const total = this.pending + elapsed;
    const h = Stroke.SUBSTEP;
    const steps = Math.floor(total / h + 1e-9);
    const x0 = this.lastX;
    const y0 = this.lastY;
    for (let k = 1; k <= steps; k++) {
      // Position at the end of sub-step k, interpolated over this sample interval.
      const f = total > 0 ? Math.min(1, (k * h - this.pending) / Math.max(elapsed, 1e-12)) : 1;
      const ff = Math.max(0, f);
      this.apply(x0 + (x - x0) * ff, y0 + (y - y0) * ff, h);
    }
    this.pending = total - steps * h;
    this.lastX = x;
    this.lastY = y;
    this.lastT = t;
  }

  end(): void {
    this.active = false;
  }
}
