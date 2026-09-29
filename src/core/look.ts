/**
 * A "look": everything a visitor chooses on the customize page. Small, plain JSON, so it can be
 * saved in the browser and exported with the design file.
 */

import { DEFAULT_VARIATION, STYLES, type StyleId, type Variation } from './variations';

/** Paper colors as sRGB hex (the Principled Base Color in Blender). */
export interface PaperColors {
  outer: string;
  inner: string;
  board: string;
}

export interface Look {
  variation: Variation;
  colors: PaperColors;
  /** Moment of the (slowly moving) pattern, seconds. */
  time: number;
}

/** The artwork's own colors: matte black cardstock, #007AFF blue paper, black board. */
export const ORIGINAL_COLORS: PaperColors = { outer: '#121416', inner: '#007aff', board: '#121416' };

export const ORIGINAL_LOOK: Look = { variation: { ...DEFAULT_VARIATION }, colors: { ...ORIGINAL_COLORS }, time: 0 };

export interface Swatch {
  name: string;
  hex: string;
}

export const PALETTES: Record<keyof PaperColors, Swatch[]> = {
  outer: [
    { name: 'Matte black', hex: '#121416' },
    { name: 'Graphite', hex: '#44484f' },
    { name: 'Navy', hex: '#1d2a47' },
    { name: 'Forest', hex: '#27443a' },
    { name: 'Terracotta', hex: '#a84f36' },
    { name: 'Sand', hex: '#d3c1a1' },
    { name: 'White', hex: '#eeece6' },
  ],
  inner: [
    { name: 'Blue', hex: '#007aff' },
    { name: 'Coral', hex: '#ff5a4e' },
    { name: 'Sunflower', hex: '#ffc400' },
    { name: 'Mint', hex: '#2ec4a0' },
    { name: 'Magenta', hex: '#e0319b' },
    { name: 'Orange', hex: '#ff8a00' },
    { name: 'White', hex: '#f4f3ef' },
  ],
  board: [
    { name: 'Matte black', hex: '#121416' },
    { name: 'Graphite', hex: '#44484f' },
    { name: 'Walnut', hex: '#5b3f2c' },
    { name: 'Oak', hex: '#b08a5f' },
    { name: 'Gray', hex: '#9aa0a8' },
    { name: 'White', hex: '#eeece6' },
  ],
};

const HEX = /^#[0-9a-f]{6}$/;

function hex(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return HEX.test(s) ? s : fallback;
}

function unit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Reads a look from untrusted JSON (browser storage, design files), filling in defaults. */
export function sanitizeLook(raw: unknown): Look {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const v = (r.variation && typeof r.variation === 'object' ? r.variation : {}) as Record<string, unknown>;
  const c = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const style = STYLES.some((s) => s.id === v.style) ? (v.style as StyleId) : DEFAULT_VARIATION.style;
  const seed = typeof v.seed === 'number' && Number.isFinite(v.seed) ? Math.floor(Math.abs(v.seed)) % 1_000_000_007 : DEFAULT_VARIATION.seed;
  const time = typeof r.time === 'number' && Number.isFinite(r.time) ? Math.max(0, r.time) : 0;
  return {
    variation: {
      style,
      intensity: unit(v.intensity, DEFAULT_VARIATION.intensity),
      scale: unit(v.scale, DEFAULT_VARIATION.scale),
      flow: unit(v.flow, DEFAULT_VARIATION.flow),
      seed,
    },
    colors: {
      outer: hex(c.outer, ORIGINAL_COLORS.outer),
      inner: hex(c.inner, ORIGINAL_COLORS.inner),
      board: hex(c.board, ORIGINAL_COLORS.board),
    },
    time,
  };
}

export function sameLook(a: Look, b: Look): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isOriginal(look: Look): boolean {
  return (
    look.variation.style === 'original' &&
    look.colors.outer === ORIGINAL_COLORS.outer &&
    look.colors.inner === ORIGINAL_COLORS.inner &&
    look.colors.board === ORIGINAL_COLORS.board
  );
}
